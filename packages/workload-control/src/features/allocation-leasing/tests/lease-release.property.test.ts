import { describe, expect, it } from "vitest";

import {
  InvalidAllocationLeaseTransitionError,
  StaleAllocationOwnerError,
  claimAllocationLease,
  createTerminalReleaseReceiptStore,
  observeLeaseExpired,
  renewAllocationLease,
  revokeAllocationLease,
  takeOverAllocationLease,
  terminalReleaseKey,
  transitionAllocationLifecycle,
  type Allocation,
  type TerminalReleaseRequest,
} from "../index.js";

function allocation(
  state: Allocation["state"] = "reserved",
  leaseState: Allocation["leaseState"] = "unowned",
): Allocation {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    executionGeneration: "generation-1",
    leaseState,
    nodeId: "synthetic-node-1",
    ownerFence: leaseState === "unowned" ? 0 : 1,
    ...(leaseState === "unowned"
      ? {}
      : { leaseOwnerId: "owner-1", leaseUntil: 10 }),
    resources: Object.freeze({ cpuMillis: 100, memoryMiB: 64 }),
    state,
    version: 1,
  });
}

function releaseRequest(
  allocationId: string | null = "allocation-1",
): TerminalReleaseRequest {
  const normalizedAllocationId = allocationId ?? undefined;
  return Object.freeze({
    ...(normalizedAllocationId === undefined
      ? {}
      : { allocationId: normalizedAllocationId }),
    attemptId: "attempt-1",
    barrierEvidenceDigest: "quiesced-1",
    executionGeneration: "generation-1",
    intent: Object.freeze({
      ...(normalizedAllocationId === undefined
        ? {}
        : { allocationId: normalizedAllocationId }),
      creatingOperationId: "terminal-op-1",
      disposition: "failed",
      evidenceDigest: "exit-1",
      evidenceKind: "execution_exit",
      evidenceVersion: 1,
      executionGeneration: "generation-1",
      precedenceDecision: "completion_won",
      terminalizationIntentId: "terminal-intent-1",
    }),
    participantDigests: Object.freeze({
      audit: "audit-1",
      capacity: "capacity-1",
      staging: "staging-1",
      tenant: "tenant-1",
    }),
    stagingDisposition: "discarded",
  });
}

describe("Phase 2 Allocation leases and owner-safe terminal release", () => {
  it("property-checks lease freshness orthogonally across every lifecycle state", () => {
    for (const lifecycle of [
      "reserved",
      "claimed",
      "active",
      "releasing",
    ] as const) {
      const claimed = claimAllocationLease(
        allocation(lifecycle),
        "owner-1",
        0,
        10,
      );
      expect(claimed).toMatchObject({
        leaseState: "current",
        ownerFence: 1,
        state: lifecycle,
      });
      const renewed = renewAllocationLease(claimed, "owner-1", 1, 20);
      expect(renewed).toMatchObject({ ownerFence: 1, state: lifecycle });
      const expired = observeLeaseExpired(renewed, 21);
      expect(expired).toMatchObject({
        leaseState: "expired",
        state: lifecycle,
      });
      const takeover = takeOverAllocationLease(expired, "owner-2", 1, 40);
      expect(takeover).toMatchObject({
        leaseOwnerId: "owner-2",
        leaseState: "current",
        ownerFence: 2,
        state: lifecycle,
      });
    }
  });

  it("supports revoked takeover without changing process identity or capacity state", () => {
    const claimed = claimAllocationLease(
      allocation("active"),
      "owner-1",
      0,
      10,
    );
    const revoked = revokeAllocationLease(claimed);
    const takeover = takeOverAllocationLease(revoked, "owner-2", 1, 30);
    expect(takeover).toMatchObject({
      allocationId: "allocation-1",
      executionGeneration: "generation-1",
      ownerFence: 2,
      state: "active",
    });
  });

  it("property-checks Allocation lifecycle and requires quiescence before releasing", () => {
    expect(transitionAllocationLifecycle(allocation(), "claimed").state).toBe(
      "claimed",
    );
    expect(() =>
      transitionAllocationLifecycle(allocation(), "releasing"),
    ).toThrow("release_before_process_quiescence");
    const releasing = transitionAllocationLifecycle(allocation(), "releasing", {
      processQuiesced: true,
      terminalizationIntentId: "intent-1",
    });
    expect(transitionAllocationLifecycle(releasing, "released").state).toBe(
      "released",
    );
  });

  it("rejects stale renewals, takeovers, and released claims", () => {
    const claimed = claimAllocationLease(allocation(), "owner-1", 0, 10);
    expect(() => renewAllocationLease(claimed, "owner-1", 0, 20)).toThrow(
      StaleAllocationOwnerError,
    );
    expect(() => takeOverAllocationLease(claimed, "owner-2", 1, 20)).toThrow(
      StaleAllocationOwnerError,
    );
    expect(() =>
      claimAllocationLease(allocation("released"), "owner-1", 0, 10),
    ).toThrow(InvalidAllocationLeaseTransitionError);
  });

  it("finalizes Allocation and no-Allocation receipts exactly once under the intent key", () => {
    for (const allocationId of ["allocation-1", null]) {
      const store = createTerminalReleaseReceiptStore();
      const request = releaseRequest(allocationId);
      const first = store.release(request);
      const duplicate = store.release(request);
      expect(duplicate).toBe(first);
      expect(first.proofId).toBe(
        `terminal-release:${terminalReleaseKey(request)}`,
      );
      expect(first.kind).toBe(
        allocationId === null ? "terminal_no_allocation" : "terminal_release",
      );
      expect(store.verify(first.proofId)).toBe(first);
    }
  });

  it("rejects same-key disposition, staging, and participant conflicts", () => {
    const store = createTerminalReleaseReceiptStore();
    const request = releaseRequest();
    store.release(request);
    expect(() =>
      store.release({
        ...request,
        stagingDisposition: "quarantined",
      }),
    ).toThrow("release_key_conflict");
    expect(() =>
      store.release({
        ...request,
        participantDigests: {
          ...request.participantDigests,
          tenant: "different",
        },
      }),
    ).toThrow("release_key_conflict");
  });

  it("never accepts a receipt request whose Allocation history disagrees with intent", () => {
    const store = createTerminalReleaseReceiptStore();
    expect(() => store.release(releaseRequest(null))).not.toThrow();
    expect(() =>
      store.release({
        ...releaseRequest(),
        allocationId: "allocation-2",
      }),
    ).toThrow("release_key_conflict");
  });
});
