import { describe, expect, it } from "vitest";

import {
  SyntheticAcceptanceTransaction,
  decidePostgresBoundaries,
} from "./gate.mjs";

const request = {
  idempotencyKey: "synthetic-caller:key-1",
  operationId: "operation-1",
  workloadId: "workload-1",
};

describe("Phase 0.5 Postgres atomic acceptance boundaries", () => {
  it("rolls back every canonical and outbox write before commit", () => {
    const store = new SyntheticAcceptanceTransaction();

    expect(() => store.accept(request, "before_commit")).toThrow(
      "synthetic crash",
    );
    expect(store.snapshot()).toEqual({
      idempotency: {},
      outbox: [],
      workloads: [],
    });
  });

  it("recovers after commit-before-ack to one stable identity and outbox event", () => {
    const store = new SyntheticAcceptanceTransaction();

    expect(() => store.accept(request, "after_commit_before_ack")).toThrow(
      "synthetic crash",
    );
    expect(store.accept(request)).toEqual({
      duplicate: true,
      workloadId: "workload-1",
    });
    expect(store.snapshot()).toEqual({
      idempotency: { "synthetic-caller:key-1": "workload-1" },
      outbox: [
        {
          operationId: "operation-1",
          type: "WorkloadAccepted",
          workloadId: "workload-1",
        },
      ],
      workloads: ["workload-1"],
    });
  });

  it("keeps the production capability unsupported without a disposable database", () => {
    expect(
      decidePostgresBoundaries({
        crashMatrixPassed: true,
        disposableDatabase: false,
        psql: true,
      }),
    ).toMatchObject({ productionGate: "closed", status: "unsupported" });
  });
});
