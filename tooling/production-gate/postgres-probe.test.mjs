import { describe, expect, it, vi } from "vitest";

import {
  atomicAcceptanceSql,
  parsePostgresCanonicalIdentity,
  postgresCommandError,
  psqlArguments,
  proveConcurrentPostgresReplay,
  runPostgresFixtureProbe,
} from "./postgres-probe.mjs";
import { postgresCrashClientEvidence } from "./postgres-stage.mjs";

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

function snapshot(workloadIds, terminalHistory) {
  return `${JSON.stringify({
    acceptedHistory: workloadIds.length,
    outbox: workloadIds.length,
    receipts: workloadIds.length,
    terminalHistory,
    workloadIds,
    workloads: workloadIds.length,
  })}\n`;
}

function actualCrashPathHarness({ beforeObservation, earlyExit = false } = {}) {
  const snapshots = [
    snapshot(["gate-workload"], 0),
    snapshot(["gate-workload"], 1),
    snapshot(["gate-after-commit-workload", "gate-workload"], 1),
    snapshot(["gate-after-commit-workload", "gate-workload"], 1),
    snapshot(["gate-after-commit-workload", "gate-workload"], 1),
  ];
  const observationQueries = [];
  const starts = [];
  const runner = {
    run: vi.fn(async (_executable, args) => {
      const sql = args.at(-1);
      if (sql === "SHOW server_version;")
        return { code: 0, stderr: "", stdout: "18.4\n" };
      if (sql.includes("pg_stat_activity")) {
        observationQueries.push(sql);
        const before = sql.includes("wf-gate-before-commit");
        return {
          code: 0,
          stderr: "",
          stdout: before
            ? (beforeObservation ?? "active|Timeout|PgSleep|before_commit\n")
            : "active|Timeout|PgSleep|after_commit\n",
        };
      }
      if (sql.includes("json_build_object"))
        return { code: 0, stderr: "", stdout: snapshots.shift() };
      if (sql.includes("WITH won AS"))
        return { code: 0, stderr: "", stdout: "gate-workload\n" };
      return { code: 0, stderr: "", stdout: "" };
    }),
    start: vi.fn(async (_executable, args, options) => {
      starts.push({ args, options });
      return {
        completion: earlyExit
          ? Promise.resolve({ code: 2, stderr: "", stdout: "" })
          : Promise.race([]),
        kill: vi.fn(),
        pid: 101 + starts.length,
      };
    }),
  };
  const config = {
    crashServer: vi.fn(async () => ({ signal: "SIGKILL" })),
    database: "wf_gate",
    host: "127.0.0.1",
    password: "synthetic-password",
    port: 5432,
    psqlExecutable: "/usr/lib/postgresql/18/bin/psql",
    runner,
    schema: "wf_gate_schema",
    user: "wf_gate",
    wait: vi.fn(() => Promise.resolve()),
  };
  return { config, observationQueries, snapshots, starts };
}

describe("Postgres crash-window actual orchestration path", () => {
  it("records an ordinary nonzero psql disconnect as an unsignaled crash observation", () => {
    expect(
      postgresCrashClientEvidence({ code: 2, stderr: "", stdout: "" }),
    ).toEqual({
      clientConnectionTerminated: true,
      clientExitCode: 2,
      clientSignal: null,
    });
  });

  it.each([
    ["success", { code: 0, stderr: "", stdout: "" }],
    ["timeout", { code: null, errorCode: "command_timeout" }],
    ["signal", { code: 2, signal: "SIGKILL" }],
  ])("rejects a %s as crash-client disconnect evidence", (_case, result) => {
    expect(() => postgresCrashClientEvidence(result)).toThrow(
      "postgres_crash_client_did_not_observe_server_failure",
    );
  });

  it("observes both long-query crash windows without relying on truncated query text", async () => {
    const harness = actualCrashPathHarness();
    await expect(
      runPostgresFixtureProbe(harness.config),
    ).resolves.toMatchObject({
      crashWindows: {
        postCommitSynchronizedBeforeKill: true,
        preCommitSynchronizedBeforeKill: true,
      },
    });
    expect(harness.starts).toHaveLength(2);
    expect(harness.snapshots).toHaveLength(0);
    expect(
      harness.starts[0].args.at(-1).indexOf("SELECT pg_sleep(30)"),
    ).toBeGreaterThan(1_024);
    expect(
      harness.starts.map(({ options }) => options.environment.PGAPPNAME),
    ).toEqual(["wf-gate-before-commit", "wf-gate-after-commit"]);
    expect(harness.observationQueries).toHaveLength(2);
    for (const sql of harness.observationQueries) {
      expect(sql).toContain("wait_event_type");
      expect(sql).toContain("backend_xid IS NULL");
      expect(sql).not.toContain("query LIKE");
      expect(sql).not.toContain("pg_sleep%");
    }
  });

  it("fails closed when the observed transaction boundary is wrong", async () => {
    const harness = actualCrashPathHarness({
      beforeObservation: "active|Timeout|PgSleep|after_commit\n",
    });
    await expect(runPostgresFixtureProbe(harness.config)).rejects.toThrow(
      "postgres_crash_window_mismatch",
    );
    expect(harness.config.crashServer).not.toHaveBeenCalled();
  });

  it("detects a crash client that exits before its window is observable", async () => {
    const harness = actualCrashPathHarness({
      beforeObservation: "\n",
      earlyExit: true,
    });
    await expect(runPostgresFixtureProbe(harness.config)).rejects.toThrow(
      "postgres_crash_client_exited_before_window",
    );
    expect(harness.config.crashServer).not.toHaveBeenCalled();
  });
});
