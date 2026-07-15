import { describe, expect, it } from "vitest";

import {
  atomicAcceptanceSql,
  parsePostgresCanonicalIdentity,
  proveConcurrentPostgresReplay,
} from "./postgres-probe.mjs";

const input = {
  callerScope: "caller",
  idempotencyKey: "key",
  operationId: "operation",
  schema: "wf_production_gate_0123456789abcdef0123456789abcdef",
  workloadId: "workload",
};

describe("Postgres concurrent acceptance replay", () => {
  it("deduplicates the winner's receipt visibility without selecting an arbitrary row", () => {
    const sql = atomicAcceptanceSql(input);
    expect(sql).toContain(
      "SELECT workload_id FROM won UNION SELECT workload_id",
    );
    expect(sql).not.toContain("UNION ALL SELECT workload_id");
    expect(sql).not.toContain("LIMIT 1");
    expect(sql).toContain("BEGIN ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("FROM created_workload");
    expect(sql).toContain("FROM created_outbox");
  });

  it("fails closed when every adversarial concurrent replay emits the identity twice", async () => {
    await expect(
      proveConcurrentPostgresReplay({
        attempt: async () => "workload\nworkload",
        expectedIdentity: "workload",
      }),
    ).rejects.toThrow("postgres_concurrent_duplicate_all_failed");
  });

  it("retries serialization losers and returns one canonical identity", async () => {
    let calls = 0;
    await expect(
      proveConcurrentPostgresReplay({
        attempt: async () => {
          calls += 1;
          if (calls < 8) throw new Error("synthetic_serialization_loser");
          return "workload";
        },
        expectedIdentity: "workload",
      }),
    ).resolves.toEqual({ attempts: 8, identity: "workload" });
    expect(calls).toBe(15);
  });

  it("accepts exactly one canonical replay identity", () => {
    expect(parsePostgresCanonicalIdentity("workload")).toBe("workload");
  });
});
