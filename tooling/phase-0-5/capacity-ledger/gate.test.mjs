import { describe, expect, it } from "vitest";

import {
  CapacityLedger,
  runCapacityLedgerGate,
  runContentionScenario,
} from "./gate.mjs";

describe("Phase 0.5 bounded capacity-ledger CAS", () => {
  it("serializes stale revisions and never overcommits hard dimensions", () => {
    const ledger = new CapacityLedger({ cpu: 2, memory: 4 });
    const revision = ledger.snapshot().revision;

    expect(ledger.tryReserve(revision, { cpu: 1, memory: 2 })).toMatchObject({
      status: "reserved",
    });
    expect(ledger.tryReserve(revision, { cpu: 1, memory: 2 })).toEqual({
      status: "cas_conflict",
    });
    expect(
      ledger.tryReserve(ledger.snapshot().revision, { cpu: 2, memory: 1 }),
    ).toEqual({
      status: "insufficient_capacity",
    });
    expect(
      ledger.tryReserve(ledger.snapshot().revision, { cpu: -1, memory: 1 }),
    ).toEqual({ status: "invalid_request" });
    expect(ledger.snapshot().reserved).toEqual({ cpu: 1, memory: 2 });
  });

  it("stays bounded under deterministic contention", async () => {
    const scenario = runContentionScenario({ attempts: 256, retryBound: 4 });

    expect(scenario.conflicts).toBeGreaterThan(0);
    expect(scenario.final.reserved.cpu).toBeLessThanOrEqual(8);
    expect(scenario.final.reserved.memory).toBeLessThanOrEqual(16);
    await expect(runCapacityLedgerGate()).resolves.toMatchObject({
      reasonCode: "transactional_capacity_contention_unverified",
      status: "unsupported",
    });
  });
});
