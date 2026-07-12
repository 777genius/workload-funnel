import { describe, expect, it, vi } from "vitest";

import {
  InvalidExecutionTransitionError,
  compareMutationFence,
  createEffectReceipt,
  fingerprintMutationFence,
  handleConditionalEffect,
  mapTerminalExecutionToAttempt,
  supersedeExecution,
  transitionExecution,
  type EffectReceiptEvidence,
  type Execution,
  type FenceAuthoritySnapshot,
  type MutationFence,
} from "../index.js";

function fence(overrides: Partial<MutationFence> = {}): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "incarnation-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "start:attempt-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "test://phase2",
    namespaceWriterEpoch: 3,
    nodeBootEpoch: 9,
    nodeId: "node-1",
    notAfter: 200,
    notBefore: 100,
    operationGateRevision: 7,
    ownerFence: 4,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "desired-start-1",
    ...overrides,
  });
}

function authority(
  overrides: Partial<FenceAuthoritySnapshot> = {},
): FenceAuthoritySnapshot {
  return Object.freeze({
    clusterIncarnation: "incarnation-1",
    clusterIncarnationVersion: 1,
    expectedDesiredVersion: 1,
    namespaceWriterEpoch: 3,
    nodeBootEpoch: 9,
    openGates: new Set(["process_start"]),
    operationGateRevision: 7,
    ownerFence: 4,
    startRevocationRevision: 0,
    supersessionKey: "desired-start-1",
    ...overrides,
  });
}

function execution(state: Execution["state"]): Execution {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    dispatchId: "dispatch-1",
    executionGeneration: "generation-1",
    executionId: "execution-1",
    observationSequence: 1,
    ownerFence: 4,
    state,
    version: 1,
    writerEpoch: 3,
  });
}

describe("Phase 2 complete mutation fencing and Execution lifecycle", () => {
  it("compares every stale tuple component before an effect", () => {
    const cases: readonly [
      Partial<MutationFence>,
      Partial<FenceAuthoritySnapshot>,
      string,
    ][] = [
      [{ namespaceWriterEpoch: 2 }, {}, "stale_writer"],
      [{ ownerFence: 3 }, {}, "stale_owner"],
      [{ operationGateRevision: 6 }, {}, "superseded_by_gate"],
      [
        { issuedStartRevocationRevision: 0 },
        { startRevocationRevision: 1 },
        "superseded_by_revocation",
      ],
      [{ expectedDesiredVersion: 0 }, {}, "superseded_by_desired_version"],
      [{ clusterIncarnation: "restored-old" }, {}, "tuple_mismatch"],
      [{ nodeBootEpoch: 8 }, {}, "tuple_mismatch"],
      [{ supersessionKey: "other" }, {}, "tuple_mismatch"],
    ];
    for (const [fenceChange, authorityChange, result] of cases) {
      expect(
        compareMutationFence(
          fence(fenceChange),
          authority(authorityChange),
          150,
        ),
      ).toBe(result);
    }
    expect(compareMutationFence(fence(), authority(), 99)).toBe(
      "not_yet_valid",
    );
    expect(compareMutationFence(fence(), authority(), 201)).toBe("expired");
    expect(compareMutationFence(fence(), authority(), 150)).toBe("current");
  });

  it("persists stable supersession receipts and creates zero effects for stale commands", () => {
    const receipts = new Map<string, EffectReceiptEvidence>();
    const apply = vi.fn(() => ({ outcome: "applied" as const }));
    const command = Object.freeze({
      fence: fence({ ownerFence: 3 }),
      operationId: "start-op-1",
    });
    const store = {
      get: (id: string) => receipts.get(id),
      save: (receipt: EffectReceiptEvidence) => {
        receipts.set(receipt.operationId, receipt);
        return receipt;
      },
    };
    const first = handleConditionalEffect(
      command,
      { id: "launcher-1", registrySequence: 10, snapshot: authority() },
      150,
      store,
      { apply },
    );
    expect(first).toMatchObject({
      comparisonResult: "stale_owner",
      outcome: "superseded",
    });
    expect(first.comparisonFields).toMatchObject({
      allocationId: "allocation-1",
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      ownerFence: 3,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(
      handleConditionalEffect(
        command,
        { id: "launcher-1", registrySequence: 11, snapshot: authority() },
        150,
        store,
        { apply },
      ),
    ).toBe(first);
  });

  it("marks an ambiguous adapter result unknown and never blindly replays it", () => {
    const receipts = new Map<string, EffectReceiptEvidence>();
    const apply = vi.fn(() => ({ outcome: "unknown" as const }));
    const store = {
      get: (id: string) => receipts.get(id),
      save: (receipt: EffectReceiptEvidence) => {
        receipts.set(receipt.operationId, receipt);
        return receipt;
      },
    };
    const command = { fence: fence(), operationId: "ambiguous-start" };
    const first = handleConditionalEffect(
      command,
      { id: "launcher-1", registrySequence: 10, snapshot: authority() },
      150,
      store,
      { apply },
    );
    const retry = handleConditionalEffect(
      command,
      { id: "launcher-1", registrySequence: 11, snapshot: authority() },
      150,
      store,
      { apply },
    );
    expect(first.outcome).toBe("unknown");
    expect(retry).toBe(first);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("requires final-authority zero-mutation proof for pre-start supersession", () => {
    const receipt = createEffectReceipt({
      authorityId: "launcher-1",
      authorityRegistrySequence: 10,
      comparisonResult: "superseded_by_revocation",
      fence: fence(),
      operationId: "start-op-1",
      outcome: "superseded",
    });
    expect(
      supersedeExecution(execution("start_requested"), receipt).state,
    ).toBe("superseded");
    expect(() => supersedeExecution(execution("starting"), receipt)).toThrow(
      InvalidExecutionTransitionError,
    );
  });

  it("represents early exit and stop directly from starting without fabricated running", () => {
    expect(transitionExecution(execution("starting"), "exited")).toMatchObject({
      observationSequence: 2,
      state: "exited",
      version: 2,
    });
    expect(transitionExecution(execution("starting"), "stopped")).toMatchObject(
      {
        state: "stopped",
        version: 2,
      },
    );
  });

  it("maps every early terminal policy without an intermediate running state", () => {
    expect(
      mapTerminalExecutionToAttempt("starting", "exited", {
        cancellationEffectWon: false,
        exitAccepted: true,
      }),
    ).toBe("publishing_results");
    expect(
      mapTerminalExecutionToAttempt("starting", "exited", {
        cancellationEffectWon: false,
        exitAccepted: false,
      }),
    ).toBe("failed");
    expect(
      mapTerminalExecutionToAttempt("unknown", "stopped", {
        cancellationEffectWon: true,
        exitAccepted: false,
        stopClassification: "cancellation",
      }),
    ).toBe("canceled");
    expect(
      mapTerminalExecutionToAttempt("starting", "stopped", {
        cancellationEffectWon: false,
        exitAccepted: false,
        stopClassification: "unexplained",
      }),
    ).toBe("reconciliation_required");
  });

  it("uses a stable canonical complete-fence fingerprint", () => {
    expect(fingerprintMutationFence(fence())).toBe(
      fingerprintMutationFence(fence()),
    );
    expect(fingerprintMutationFence(fence({ ownerFence: 5 }))).not.toBe(
      fingerprintMutationFence(fence()),
    );
  });
});
