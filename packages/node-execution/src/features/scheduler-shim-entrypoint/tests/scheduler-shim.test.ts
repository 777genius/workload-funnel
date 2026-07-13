import { describe, expect, it } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";
import type { SignedExecutionTicket } from "@workload-funnel/node-execution/execution-ticket-validation";
import {
  LAUNCHER_RPC_PROTOCOL,
  type LauncherRpcRequest,
  type LauncherRpcResponse,
} from "@workload-funnel/node-execution/process-lifecycle";
import {
  DurableObservationSpool,
  type ObservationSpoolStorage,
} from "@workload-funnel/node-execution/observation-spooling";
import {
  runSchedulerShim,
  type SchedulerShimInvocation,
  type SchedulerShimLauncher,
} from "@workload-funnel/node-execution/scheduler-shim-entrypoint";

class MemorySpoolStorage implements ObservationSpoolStorage {
  public readonly capacity = 100;
  readonly #lines: string[] = [];

  public appendAndSync(line: string): void {
    this.#lines.push(line);
  }

  public readAll(): readonly string[] {
    return this.#lines;
  }
}

function ticket(): SignedExecutionTicket {
  const mutationFence: MutationFence = {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "process:allocation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "test://phase7",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "process:allocation-1",
  };
  return {
    claims: {
      allocation: {
        allocationId: "allocation-1",
        attemptId: "attempt-1",
        executionGeneration: "generation-1",
        ownerFence: 1,
        ownerId: "owner-1",
      },
      attempt: {
        attemptId: "attempt-1",
        executionGeneration: "generation-1",
        startFence: "start-fence-1",
        startRevocationRevision: 0,
      },
      cluster: { incarnationId: "cluster-1", version: 1 },
      expiresAtMs: 20_000,
      gate: { effect: "process_start", open: true, revision: 1 },
      issuedAtMs: 1,
      issuerKeyId: "issuer-1",
      mutationFence,
      mutationFenceFingerprint: "fence-fingerprint-1",
      namespace: {
        namespaceId: "test://phase7",
        writerEpoch: 1,
        writerId: "writer-1",
      },
      node: { bootEpoch: 1, bootId: "boot-1", nodeId: "node-1" },
      nonce: "nonce-1",
      operationId: "start-1",
      partitionPolicy: "terminate_after_grace",
      profileId: "synthetic-process-tree-v1",
      sandboxProfileDigest: "a".repeat(64),
      schemaVersion: "phase4c.execution-ticket.v1",
      ticketId: "ticket-1",
    },
    signatureBase64Url: "synthetic",
  };
}

function invocation(): SchedulerShimInvocation {
  return {
    dispatchId: "dispatch-1",
    mappingFingerprint: "mapping-1",
    protocolVersion: "phase7.scheduler-shim.v1",
    ticket: ticket(),
  };
}

function success(
  request: LauncherRpcRequest,
  state: "active" | "inactive" | "started" | "stopped" | "unknown",
): LauncherRpcResponse {
  return {
    ok: true,
    protocolVersion: LAUNCHER_RPC_PROTOCOL,
    requestId: request.requestId,
    result: { state, unitName: "wf-exec-allocation-1-generation-1.service" },
  };
}

describe("Phase 7 synchronous node-launcher scheduler shim", () => {
  it("stays in the ordinary launcher path until a terminal observation", async () => {
    let observations = 0;
    let verified = 0;
    const launcher: SchedulerShimLauncher = {
      exchange(request) {
        if (request.method === "start")
          return Promise.resolve(success(request, "started"));
        observations += 1;
        return Promise.resolve(
          success(request, observations === 1 ? "active" : "inactive"),
        );
      },
    };
    const spool = new DurableObservationSpool(new MemorySpoolStorage());
    const result = await runSchedulerShim(invocation(), {
      cancelRequested: () => false,
      launcher,
      maxObservations: 5,
      nowMs: () => 10,
      observationSpool: spool,
      poll: () => Promise.resolve(),
      verifyTicket: () => {
        verified += 1;
      },
    });
    expect(result).toMatchObject({
      dispatchEvidence: { observed: "terminal" },
      disposition: "exited",
    });
    expect(verified).toBe(1);
    expect(observations).toBe(2);
    expect(spool.pending.map((item) => item.state)).toEqual([
      "active",
      "exited",
    ]);
  });

  it("forwards cancellation through launcher stop and never treats connection loss as success", async () => {
    const methods: string[] = [];
    const canceled = await runSchedulerShim(invocation(), {
      cancelRequested: () => true,
      launcher: {
        exchange(request) {
          methods.push(request.method);
          if (request.method === "start")
            return Promise.resolve(success(request, "started"));
          return Promise.resolve(success(request, "stopped"));
        },
      },
      maxObservations: 2,
      nowMs: () => 10,
      observationSpool: new DurableObservationSpool(new MemorySpoolStorage()),
      poll: () => Promise.resolve(),
      verifyTicket: () => undefined,
    });
    expect(canceled.disposition).toBe("stopped");
    expect(methods).toEqual(["start", "stop", "observe"]);

    const unknownSpool = new DurableObservationSpool(new MemorySpoolStorage());
    const unknown = await runSchedulerShim(invocation(), {
      cancelRequested: () => false,
      launcher: {
        exchange(request) {
          return Promise.resolve(
            success(
              request,
              request.method === "start" ? "started" : "unknown",
            ),
          );
        },
      },
      maxObservations: 1,
      nowMs: () => 10,
      observationSpool: unknownSpool,
      poll: () => Promise.resolve(),
      verifyTicket: () => undefined,
    });
    expect(unknown).toMatchObject({
      dispatchEvidence: { complete: false },
      disposition: "unknown",
    });
    expect(unknownSpool.pending.at(-1)).toMatchObject({
      kind: "observation",
      state: "unknown",
    });

    const rejectedConnection = await runSchedulerShim(invocation(), {
      cancelRequested: () => false,
      launcher: {
        exchange() {
          return Promise.reject(new Error("synthetic connection loss"));
        },
      },
      maxObservations: 1,
      nowMs: () => 10,
      observationSpool: new DurableObservationSpool(new MemorySpoolStorage()),
      poll: () => Promise.resolve(),
      verifyTicket: () => undefined,
    });
    expect(rejectedConnection).toMatchObject({
      dispatchEvidence: { complete: false },
      disposition: "unknown",
    });
  });
});
