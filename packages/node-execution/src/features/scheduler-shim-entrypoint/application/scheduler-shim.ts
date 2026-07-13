import { createHash } from "node:crypto";

import type { DispatchEvidence } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { SignedExecutionTicket } from "@workload-funnel/node-execution/execution-ticket-validation";
import type { DurableObservationSpool } from "@workload-funnel/node-execution/observation-spooling";
import {
  LAUNCHER_RPC_PROTOCOL,
  type LauncherRpcRequest,
  type LauncherRpcResponse,
} from "@workload-funnel/node-execution/process-lifecycle";

export const SCHEDULER_SHIM_PROTOCOL = "phase7.scheduler-shim.v1" as const;

export interface SchedulerShimInvocation {
  readonly dispatchId: string;
  readonly mappingFingerprint: string;
  readonly protocolVersion: typeof SCHEDULER_SHIM_PROTOCOL;
  readonly ticket: SignedExecutionTicket;
}

export interface SchedulerShimLauncher {
  exchange(request: LauncherRpcRequest): Promise<LauncherRpcResponse>;
}

export interface SchedulerShimDependencies {
  readonly cancelRequested: () => boolean;
  readonly launcher: SchedulerShimLauncher;
  readonly maxObservations: number;
  readonly nowMs: () => number;
  readonly observationSpool: DurableObservationSpool;
  readonly poll: () => Promise<void>;
  readonly verifyTicket: (ticket: SignedExecutionTicket) => void;
}

export interface SchedulerShimResult {
  readonly dispatchEvidence: DispatchEvidence;
  readonly disposition: "exited" | "failed" | "stopped" | "unknown";
  readonly unitName?: string;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

function request(
  method: LauncherRpcRequest["method"],
  invocation: SchedulerShimInvocation,
  suffix: string,
): LauncherRpcRequest {
  return {
    method,
    protocolVersion: LAUNCHER_RPC_PROTOCOL,
    requestId: `hq-shim:${invocation.dispatchId}:${suffix}`,
    ticket: invocation.ticket,
  };
}

function evidence(
  invocation: SchedulerShimInvocation,
  state: DispatchEvidence["observed"],
  complete: boolean,
  sequence: number,
): DispatchEvidence {
  return Object.freeze({
    complete,
    digest: digest({
      dispatchId: invocation.dispatchId,
      mappingFingerprint: invocation.mappingFingerprint,
      sequence,
      state,
    }),
    kind: "node_process",
    observed: state,
    source: "scheduler-shim",
    sourceEpoch: invocation.ticket.claims.node.bootEpoch,
    sourceSequence: sequence,
  });
}

function spool(
  dependencies: SchedulerShimDependencies,
  invocation: SchedulerShimInvocation,
  state: "active" | "exited" | "failed" | "stopped" | "unknown",
  sequence: number,
): void {
  const claims = invocation.ticket.claims;
  dependencies.observationSpool.append({
    bootEpoch: claims.node.bootEpoch,
    eventId: `hq-shim:${invocation.dispatchId}:${String(sequence)}`,
    executionGeneration: claims.allocation.executionGeneration,
    executionId: `execution-${claims.allocation.allocationId}`,
    kind:
      state === "active" || state === "unknown"
        ? "observation"
        : "terminal_result",
    nodeId: claims.node.nodeId,
    observedAtMs: dependencies.nowMs(),
    payloadDigest: digest({ state, unit: claims.allocation.allocationId }),
    sourceSequence: sequence,
    state,
  });
}

async function exchange(
  launcher: SchedulerShimLauncher,
  rpcRequest: LauncherRpcRequest,
): Promise<LauncherRpcResponse | undefined> {
  try {
    return await launcher.exchange(rpcRequest);
  } catch {
    return undefined;
  }
}

export async function runSchedulerShim(
  invocation: SchedulerShimInvocation,
  dependencies: SchedulerShimDependencies,
): Promise<SchedulerShimResult> {
  const protocolVersion: unknown = invocation.protocolVersion;
  if (
    Object.keys(invocation).sort().join() !==
      ["dispatchId", "mappingFingerprint", "protocolVersion", "ticket"]
        .sort()
        .join() ||
    protocolVersion !== SCHEDULER_SHIM_PROTOCOL ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(invocation.dispatchId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(invocation.mappingFingerprint)
  )
    throw new Error("scheduler_shim_protocol_unsupported");
  if (
    !Number.isSafeInteger(dependencies.maxObservations) ||
    dependencies.maxObservations < 1
  )
    throw new Error("scheduler_shim_observation_limit_invalid");
  dependencies.verifyTicket(invocation.ticket);
  const started = await exchange(
    dependencies.launcher,
    request("start", invocation, "start"),
  );
  if (
    started === undefined ||
    !started.ok ||
    !["started", "active"].includes(started.result.state)
  ) {
    spool(dependencies, invocation, "unknown", 1);
    return {
      dispatchEvidence: evidence(
        invocation,
        "reconciliation_required",
        false,
        1,
      ),
      disposition: "unknown",
    };
  }
  spool(dependencies, invocation, "active", 1);
  let stopSent = false;
  for (let index = 1; index <= dependencies.maxObservations; index += 1) {
    if (dependencies.cancelRequested() && !stopSent) {
      stopSent = true;
      const stopped = await exchange(
        dependencies.launcher,
        request("stop", invocation, `stop:${String(index)}`),
      );
      if (stopped?.ok !== true) {
        spool(dependencies, invocation, "unknown", index + 1);
        return {
          dispatchEvidence: evidence(
            invocation,
            "reconciliation_required",
            false,
            index + 1,
          ),
          disposition: "unknown",
          unitName: started.result.unitName,
        };
      }
    }
    const observed = await exchange(
      dependencies.launcher,
      request("observe", invocation, `observe:${String(index)}`),
    );
    if (
      observed === undefined ||
      !observed.ok ||
      observed.result.state === "unknown"
    ) {
      spool(dependencies, invocation, "unknown", index + 1);
      return {
        dispatchEvidence: evidence(
          invocation,
          "reconciliation_required",
          false,
          index + 1,
        ),
        disposition: "unknown",
        unitName: started.result.unitName,
      };
    }
    if (["inactive", "failed", "stopped"].includes(observed.result.state)) {
      const disposition =
        observed.result.state === "inactive"
          ? "exited"
          : observed.result.state === "stopped"
            ? "stopped"
            : "failed";
      spool(dependencies, invocation, disposition, index + 1);
      return {
        dispatchEvidence: evidence(invocation, "terminal", true, index + 1),
        disposition,
        unitName: observed.result.unitName,
      };
    }
    try {
      await dependencies.poll();
    } catch {
      spool(dependencies, invocation, "unknown", index + 1);
      return {
        dispatchEvidence: evidence(
          invocation,
          "reconciliation_required",
          false,
          index + 1,
        ),
        disposition: "unknown",
        unitName: started.result.unitName,
      };
    }
  }
  spool(dependencies, invocation, "unknown", dependencies.maxObservations + 2);
  return {
    dispatchEvidence: evidence(
      invocation,
      "reconciliation_required",
      false,
      dependencies.maxObservations + 2,
    ),
    disposition: "unknown",
    unitName: started.result.unitName,
  };
}
