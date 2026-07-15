import { describe, expect, it } from "vitest";

import {
  atomicAcceptanceSql,
  parsePostgresCanonicalIdentity,
  postgresCommandError,
  psqlArguments,
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
        attempt: async () => "workload\nworkload\n",
        expectedIdentity: "workload",
      }),
    ).rejects.toThrow("postgres_gate_identity_malformed");
  });

  it("suppresses real multi-statement psql command statuses instead of filtering them", () => {
    const args = psqlArguments({
      database: "wf_gate",
      host: "127.0.0.1",
      port: 5432,
      sql: atomicAcceptanceSql(input),
      user: "wf_gate",
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--no-psqlrc",
        "--quiet",
        "ON_ERROR_STOP=1",
        "VERBOSITY=verbose",
        "--tuples-only",
        "--no-align",
      ]),
    );
    expect(() =>
      parsePostgresCanonicalIdentity("BEGIN\nSET\nworkload\nCOMMIT\n"),
    ).toThrow("postgres_gate_identity_malformed");
  });

  it("retries serialization losers and returns one canonical identity", async () => {
    let calls = 0;
    await expect(
      proveConcurrentPostgresReplay({
        attempt: async () => {
          calls += 1;
          if (calls < 8)
            throw postgresCommandError({
              stderr:
                "psql: ERROR:  40001: could not serialize access due to concurrent update",
            });
          return "workload\n";
        },
        expectedIdentity: "workload",
      }),
    ).resolves.toEqual({ attempts: 8, identity: "workload" });
    expect(calls).toBe(15);
  });

  it("does not retry a non-serialization psql failure", async () => {
    const failure = postgresCommandError({
      stderr: "psql: ERROR:  23505: synthetic constraint failure",
    });
    expect(failure).toMatchObject({
      message: "postgres_fixture_command_failed",
    });
    await expect(
      proveConcurrentPostgresReplay({
        attempt: async () => {
          throw failure;
        },
        expectedIdentity: "workload",
      }),
    ).rejects.toBe(failure);
  });

  it("accepts exactly one canonical replay identity", () => {
    expect(parsePostgresCanonicalIdentity("workload\n")).toBe("workload");
  });

  it.each([
    ["different", "foreign-workload\n"],
    ["duplicate", "workload\nworkload\n"],
    ["transaction statuses", "BEGIN\nworkload\nCOMMIT\n"],
    ["missing row terminator", "workload"],
  ])("fails closed on a %s replay identity", async (_case, output) => {
    await expect(
      proveConcurrentPostgresReplay({
        attempt: async () => output,
        expectedIdentity: "workload",
      }),
    ).rejects.toThrow(
      output === "foreign-workload\n"
        ? "postgres_concurrent_duplicate_identity_unstable"
        : "postgres_gate_identity_malformed",
    );
  });
});
