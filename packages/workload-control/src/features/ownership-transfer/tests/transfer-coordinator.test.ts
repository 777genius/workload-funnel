import { describe, expect, it } from "vitest";
import type { MutationFence } from "@workload-funnel/kernel";

import {
  advanceOwnershipTransferCoordinator,
  createOwnershipTransferCoordinator,
  nextOwnershipTransferStep,
} from "../index.js";

const mutationFence: MutationFence = Object.freeze({
  attemptId: "attempt-transfer-1",
  clusterIncarnation: "synthetic-phase1-cluster",
  clusterIncarnationVersion: 1,
  desiredEffect: "process_start",
  effectScopeKey: "process:attempt-transfer-1",
  executionGeneration: "generation-transfer-1",
  expectedDesiredVersion: 1,
  issuedStartRevocationRevision: 0,
  namespaceId: "namespace-1",
  namespaceWriterEpoch: 1,
  operationGateRevision: 5,
  requiredGate: "process_start",
  schemaVersion: 1,
  startFence: "start-transfer-1",
  supersessionKey: "process:attempt-transfer-1",
});

function coordinator() {
  return createOwnershipTransferCoordinator({
    authorityIds: ["launcher-1", "gateway-1"],
    gateRevision: 5,
    mutationFence,
    namespaceId: "namespace-1",
    operationId: "transfer-1",
    ownershipVersion: 1,
    targetWriterId: "writer-b",
    targetWriterRelease: "release-b",
  });
}

describe("Phase 2 crash-resumable ownership transfer", () => {
  it("resumes every cutover step deterministically after a synthetic crash", () => {
    let current = coordinator();
    const observed = [current.step];
    while (nextOwnershipTransferStep(current) !== undefined) {
      const next = nextOwnershipTransferStep(current);
      if (next === undefined) break;
      const committed = advanceOwnershipTransferCoordinator(
        current,
        next,
        `evidence:${next}`,
        next === "epoch_advanced" ? 3 : current.ownershipVersion,
        next === "gates_closed" ? 6 : current.gateRevision,
      );
      const recovered = Object.freeze({ ...committed });
      expect(
        advanceOwnershipTransferCoordinator(
          recovered,
          next,
          `evidence:${next}`,
          recovered.ownershipVersion,
          recovered.gateRevision,
        ),
      ).toBe(recovered);
      current = recovered;
      observed.push(current.step);
    }
    expect(observed).toEqual([
      "begun",
      "gates_closed",
      "old_effects_drained",
      "old_authorities_fenced",
      "epoch_advanced",
      "new_authorities_installed",
      "old_credentials_disabled",
      "ownership_completed",
      "gates_reopened",
    ]);
  });

  it("never permits abort after the canonical epoch CAS", () => {
    let current = coordinator();
    for (const step of [
      "gates_closed",
      "old_effects_drained",
      "old_authorities_fenced",
      "epoch_advanced",
    ] as const) {
      current = advanceOwnershipTransferCoordinator(current, step, step);
    }
    expect(() =>
      advanceOwnershipTransferCoordinator(current, "aborted", "failure"),
    ).toThrow("post_cas_transfer_cannot_abort");
  });

  it("allows a pre-CAS abort and keeps gates reopening separately authorized", () => {
    const closed = advanceOwnershipTransferCoordinator(
      coordinator(),
      "gates_closed",
      "closed-revision-6",
    );
    const aborted = advanceOwnershipTransferCoordinator(
      closed,
      "aborted",
      "pre-cas-failure",
    );
    expect(aborted.step).toBe("aborted");
    expect(nextOwnershipTransferStep(aborted)).toBeUndefined();
  });
});
