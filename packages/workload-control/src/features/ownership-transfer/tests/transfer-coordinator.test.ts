import { describe, expect, it } from "vitest";

import {
  advanceOwnershipTransferCoordinator,
  createOwnershipTransferCoordinator,
  nextOwnershipTransferStep,
} from "../index.js";

function coordinator() {
  return createOwnershipTransferCoordinator({
    authorityIds: ["launcher-1", "gateway-1"],
    gateRevision: 5,
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
