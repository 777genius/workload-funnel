import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

import { prepareRuntimeExecutionTicket } from "@workload-funnel/bridge-subscription-runtime/execution-ticket-preparation";
import { createProvider as createRuntimeEventProvider } from "@workload-funnel/bridge-subscription-runtime/runtime-event-consumption";
import {
  fingerprintMutationFence,
  type FenceAuthoritySnapshot,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  TargetExecutionTicket,
  TargetOperationIntent,
  TargetOperationObservation,
} from "@workload-funnel/node-execution/process-lifecycle";
import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import type { Attempt } from "@workload-funnel/workload-control/workload-lifecycle";

export function compileNativeHelper(
  source: string,
  output: string,
  boundary: "artifact" | "sealer",
): void {
  const compilation = spawnSync(
    "/usr/bin/cc",
    [
      "-std=c17",
      boundary === "artifact"
        ? "-DWF_ARTIFACT_STORE_ONLY"
        : "-DWF_RESULT_SEALER_ONLY",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      source,
      "-o",
      output,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } },
  );
  if (compilation.status !== 0)
    throw new Error(compilation.stderr || "native_e2e_helper_build_failed");
}

export function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function startFence(
  attempt: Attempt,
  allocation: Allocation,
  overrides: Partial<MutationFence> = {},
): MutationFence {
  return Object.freeze({
    allocationId: allocation.allocationId,
    attemptId: attempt.attemptId,
    clusterIncarnation: "full-lifecycle-cluster",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: `process:${attempt.attemptId}`,
    executionGeneration: attempt.executionGeneration,
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: attempt.startRevocationRevision,
    namespaceId: "full-lifecycle-namespace",
    namespaceWriterEpoch: 2,
    nodeBootEpoch: 1,
    nodeId: allocation.nodeId,
    notAfter: 10_000,
    notBefore: 1_000,
    operationGateRevision: 1,
    ownerFence: allocation.ownerFence,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: attempt.startFence,
    supersessionKey: `process:${attempt.attemptId}`,
    ...overrides,
  });
}

export function resultFence(
  attempt: Attempt,
  allocation: Allocation,
  desiredEffect: "seal_output" | "artifact_stage" | "artifact_finalize",
  effectScopeKey: string,
): MutationFence {
  return Object.freeze({
    allocationId: allocation.allocationId,
    attemptId: attempt.attemptId,
    clusterIncarnation: "full-lifecycle-cluster",
    clusterIncarnationVersion: 1,
    desiredEffect,
    effectScopeKey,
    executionGeneration: attempt.executionGeneration,
    expectedDesiredVersion: 1,
    namespaceId: "test://phase1/walking-slice",
    namespaceWriterEpoch: 2,
    nodeBootEpoch: 1,
    nodeId: allocation.nodeId,
    notAfter: 10_000,
    notBefore: 1_000,
    operationGateRevision: 1,
    ownerFence: allocation.ownerFence,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: effectScopeKey,
  });
}

export function runtimeIntent(
  fence: MutationFence,
  suffix: string,
): TargetOperationIntent {
  const ticket: TargetExecutionTicket = Object.freeze({
    causationId: `cause-${suffix}`,
    correlationId: `correlation-${suffix}`,
    expiresAtMs: fence.notAfter ?? 0,
    idempotencyKey: `runtime-idempotency-${suffix}`,
    issuedAtMs: fence.notBefore ?? 0,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: `runtime-start-${suffix}`,
    projectId: "disposable-synthetic-project",
    requestId: `runtime-request-${suffix}`,
    runtimeTargetId: "synthetic-runtime-target",
    sandboxProfileDigest: digest("trusted-synthetic-profile"),
    ticketId: `runtime-ticket-${suffix}`,
  });
  return Object.freeze({
    boundary: "runtime",
    kind: "start",
    ticket: prepareRuntimeExecutionTicket(ticket),
  });
}

export function authoritySnapshot(
  fence: MutationFence,
): FenceAuthoritySnapshot {
  return Object.freeze({
    attemptId: fence.attemptId,
    clusterIncarnation: fence.clusterIncarnation,
    clusterIncarnationVersion: fence.clusterIncarnationVersion,
    desiredEffect: fence.desiredEffect,
    effectScopeKey: fence.effectScopeKey,
    executionGeneration: fence.executionGeneration,
    expectedDesiredVersion: fence.expectedDesiredVersion,
    namespaceId: fence.namespaceId,
    namespaceWriterEpoch: fence.namespaceWriterEpoch,
    openGates: new Set([fence.requiredGate]),
    operationGateRevision: fence.operationGateRevision,
    requiredGate: fence.requiredGate,
    supersessionKey: fence.supersessionKey,
    ...(fence.allocationId === undefined
      ? {}
      : { allocationId: fence.allocationId }),
    ...(fence.ownerFence === undefined ? {} : { ownerFence: fence.ownerFence }),
    ...(fence.startFence === undefined ? {} : { startFence: fence.startFence }),
    ...(fence.issuedStartRevocationRevision === undefined
      ? {}
      : { startRevocationRevision: fence.issuedStartRevocationRevision }),
    ...(fence.nodeId === undefined ? {} : { nodeId: fence.nodeId }),
    ...(fence.nodeBootEpoch === undefined
      ? {}
      : { nodeBootEpoch: fence.nodeBootEpoch }),
  });
}

export function runtimeEvent(
  receipt: Readonly<{ operationId: string; runtimeOperationId?: string }>,
  state: "unknown" | "exited",
  terminal?: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    causationId: "runtime-event-cause",
    controllerId: "full-lifecycle-controller",
    cursor: `cursor-${state}-${terminal === undefined ? "none" : "terminal"}`,
    operationId: receipt.operationId,
    projectId: "disposable-synthetic-project",
    runtimeBuildSha: "1".repeat(40),
    runtimeOperationId: receipt.runtimeOperationId ?? "missing-runtime-receipt",
    schemaVersion: "subscription-runtime.event.v1",
    sourceRevision: 1,
    state,
    targetId: "synthetic-runtime-target",
    ...(terminal === undefined ? {} : { terminal }),
  });
}

export async function consumeEvent(
  event: Readonly<Record<string, unknown>>,
): Promise<TargetOperationObservation> {
  const source = createRuntimeEventProvider({
    client: {
      readEvents: () =>
        Promise.resolve({
          events: [event],
          schemaVersion: "subscription-runtime.event-page.v1",
        }),
      readProjectSnapshot: () =>
        Promise.resolve({
          entries: [],
          schemaVersion: "subscription-runtime.snapshot-page.v1",
        }),
    },
    controllerId: "full-lifecycle-controller",
    targetId: "synthetic-runtime-target",
  });
  const observed = (await source.readEvents(undefined, 1)).events[0];
  if (observed === undefined) throw new Error("runtime_event_missing");
  return observed;
}
