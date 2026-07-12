import { describe, expect, it } from "vitest";

import {
  assertRestoreAdmissionOpen,
  createAcceptanceDurabilityReceipt,
  evaluateRestoreSafety,
  reconcileAcceptanceWitness,
  type ExternalAcceptanceWitness,
  type WitnessRecord,
} from "../index.js";

function witness(
  result: ReturnType<ExternalAcceptanceWitness["appendOrLookupExact"]>,
): ExternalAcceptanceWitness {
  return Object.freeze({ appendOrLookupExact: () => result });
}

describe("Phase 2 durability profiles, external witness, and restore quarantine", () => {
  it("returns success for externally witnessed acceptance only after exact confirm", () => {
    const pending = createAcceptanceDurabilityReceipt(
      "submit-1",
      "incarnation-1",
      "externally_witnessed",
      10,
      "wal-10",
    );
    expect(pending.state).toBe("witness_pending");
    const record: WitnessRecord = Object.freeze({
      acceptanceSequence: 10,
      clusterIncarnation: "incarnation-1",
      commitReference: "wal-10",
      digest: "witness-digest-10",
      operationId: "submit-1",
    });
    const confirmed = reconcileAcceptanceWitness(
      pending,
      witness({ outcome: "confirmed", record }),
    );
    expect(confirmed).toMatchObject({
      state: "witness_confirmed",
      witnessDigest: "witness-digest-10",
    });
    expect(
      reconcileAcceptanceWitness(
        confirmed,
        witness({ outcome: "unavailable" }),
      ),
    ).toBe(confirmed);
  });

  it("keeps unavailable and ambiguous witness outcomes unknown without another Workload", () => {
    const pending = createAcceptanceDurabilityReceipt(
      "submit-1",
      "incarnation-1",
      "externally_witnessed",
      10,
      "wal-10",
    );
    expect(
      reconcileAcceptanceWitness(pending, witness({ outcome: "unavailable" })),
    ).toBe(pending);
    expect(
      reconcileAcceptanceWitness(pending, witness({ outcome: "unknown" })),
    ).toBe(pending);
  });

  it("quarantines a conflicting external witness", () => {
    const pending = createAcceptanceDurabilityReceipt(
      "submit-1",
      "incarnation-1",
      "externally_witnessed",
      10,
      "wal-10",
    );
    const conflict: WitnessRecord = Object.freeze({
      acceptanceSequence: 9,
      clusterIncarnation: "incarnation-1",
      commitReference: "wal-9",
      digest: "conflict",
      operationId: "submit-1",
    });
    expect(
      reconcileAcceptanceWitness(
        pending,
        witness({ outcome: "conflict", record: conflict }),
      ).state,
    ).toBe("witness_quarantined");
  });

  it("blocks admission until gap and execution reconciliation both complete", () => {
    const gap = evaluateRestoreSafety({
      clusterIncarnation: "restored-incarnation",
      executionReconciliationComplete: false,
      externalHighWatermark: 12,
      gapReconciliationComplete: false,
      recoveredHighWatermark: 10,
    });
    expect(gap.state).toBe("restore_quarantine");
    expect(() => {
      assertRestoreAdmissionOpen(gap);
    }).toThrow("restore_quarantine");
    const ready = evaluateRestoreSafety({
      clusterIncarnation: "rotated-incarnation",
      executionReconciliationComplete: true,
      externalHighWatermark: 12,
      gapReconciliationComplete: true,
      recoveredHighWatermark: 12,
    });
    expect(() => {
      assertRestoreAdmissionOpen(ready);
    }).not.toThrow();
  });
});
