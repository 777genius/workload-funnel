const sqlIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;
const gateValue = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

class PostgresSerializationFailure extends Error {
  constructor() {
    super("postgres_serialization_failure");
    this.code = "40001";
  }
}

export function postgresCommandError({ stderr = "", stdout = "" }) {
  if (/\bERROR:\s+40001:/u.test(`${stderr}\n${stdout}`))
    return new PostgresSerializationFailure();
  return new Error("postgres_fixture_command_failed");
}

function identifier(value) {
  if (!sqlIdentifier.test(value))
    throw new Error("unsafe_postgres_gate_identifier");
  return value;
}

function literal(value) {
  if (!gateValue.test(value)) throw new Error("unsafe_postgres_gate_value");
  return `'${value}'`;
}

export function postgresSchemaSql(schema) {
  const name = identifier(schema);
  return [
    "BEGIN ISOLATION LEVEL SERIALIZABLE;",
    `CREATE SCHEMA ${name};`,
    `CREATE TABLE ${name}.idempotency_receipt (caller_scope text NOT NULL, idempotency_key text NOT NULL, workload_id text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (caller_scope, idempotency_key));`,
    `CREATE TABLE ${name}.workload (workload_id text PRIMARY KEY, accepted_at timestamptz NOT NULL DEFAULT clock_timestamp());`,
    `CREATE TABLE ${name}.outbox (operation_id text PRIMARY KEY, workload_id text NOT NULL REFERENCES ${name}.workload(workload_id), event_type text NOT NULL CHECK (event_type = 'WorkloadAccepted'));`,
    `CREATE TABLE ${name}.history (history_id text PRIMARY KEY, workload_id text NOT NULL REFERENCES ${name}.workload(workload_id), kind text NOT NULL CHECK (kind IN ('accepted', 'terminal')), payload_digest text NOT NULL);`,
    "COMMIT;",
  ].join("\n");
}

export function atomicAcceptanceSql({
  callerScope,
  idempotencyKey,
  operationId,
  schema,
  workloadId,
}) {
  const name = identifier(schema);
  return [
    "BEGIN ISOLATION LEVEL SERIALIZABLE;",
    "SET LOCAL lock_timeout = '5s';",
    `WITH won AS (INSERT INTO ${name}.idempotency_receipt (caller_scope, idempotency_key, workload_id) VALUES (${literal(callerScope)}, ${literal(idempotencyKey)}, ${literal(workloadId)}) ON CONFLICT (caller_scope, idempotency_key) DO NOTHING RETURNING workload_id),`,
    `created_workload AS (INSERT INTO ${name}.workload (workload_id) SELECT workload_id FROM won ON CONFLICT DO NOTHING RETURNING workload_id),`,
    `created_outbox AS (INSERT INTO ${name}.outbox (operation_id, workload_id, event_type) SELECT ${literal(operationId)}, workload_id, 'WorkloadAccepted' FROM created_workload ON CONFLICT DO NOTHING RETURNING workload_id),`,
    `created_history AS (INSERT INTO ${name}.history (history_id, workload_id, kind, payload_digest) SELECT ${literal(`history-${operationId}`)}, workload_id, 'accepted', ${literal(`sha256:${"a".repeat(64)}`)} FROM created_outbox ON CONFLICT DO NOTHING RETURNING workload_id)`,
    `SELECT workload_id FROM won UNION SELECT workload_id FROM ${name}.idempotency_receipt WHERE caller_scope = ${literal(callerScope)} AND idempotency_key = ${literal(idempotencyKey)};`,
    "COMMIT;",
  ].join("\n");
}

export function postgresSnapshotSql(schema) {
  const name = identifier(schema);
  return `SELECT json_build_object('receipts', (SELECT count(*) FROM ${name}.idempotency_receipt), 'workloads', (SELECT count(*) FROM ${name}.workload), 'outbox', (SELECT count(*) FROM ${name}.outbox), 'acceptedHistory', (SELECT count(*) FROM ${name}.history WHERE kind = 'accepted'), 'terminalHistory', (SELECT count(*) FROM ${name}.history WHERE kind = 'terminal'), 'workloadIds', (SELECT coalesce(json_agg(workload_id ORDER BY workload_id), '[]'::json) FROM ${name}.workload))::text;`;
}

export function terminalHistorySql({ operationId, schema, workloadId }) {
  const name = identifier(schema);
  return [
    "BEGIN ISOLATION LEVEL SERIALIZABLE;",
    `INSERT INTO ${name}.history (history_id, workload_id, kind, payload_digest) VALUES (${literal(`terminal-${operationId}`)}, ${literal(workloadId)}, 'terminal', ${literal(`sha256:${"b".repeat(64)}`)}) ON CONFLICT DO NOTHING;`,
    "COMMIT;",
  ].join("\n");
}

export function psqlArguments({ database, host, port, sql, user }) {
  if (
    !sqlIdentifier.test(database) ||
    !gateValue.test(host) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !gateValue.test(user) ||
    typeof sql !== "string" ||
    sql.length > 256 * 1024
  )
    throw new Error("unsafe_psql_gate_arguments");
  return Object.freeze([
    "--no-psqlrc",
    "--quiet",
    "--set",
    "ON_ERROR_STOP=1",
    "--set",
    "VERBOSITY=verbose",
    "--host",
    host,
    "--port",
    String(port),
    "--username",
    user,
    "--dbname",
    database,
    "--tuples-only",
    "--no-align",
    "--command",
    sql,
  ]);
}

export function parsePostgresSnapshot(output) {
  let decoded;
  try {
    decoded = JSON.parse(output.trim());
  } catch {
    throw new Error("postgres_gate_snapshot_malformed");
  }
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    !Array.isArray(decoded.workloadIds) ||
    [
      decoded.receipts,
      decoded.workloads,
      decoded.outbox,
      decoded.acceptedHistory,
      decoded.terminalHistory,
    ].some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error("postgres_gate_snapshot_invalid");
  return Object.freeze(decoded);
}

function parsePsqlSingleRow(output, malformed) {
  if (
    typeof output !== "string" ||
    !output.endsWith("\n") ||
    output.includes("\r") ||
    output.slice(0, -1).includes("\n")
  )
    throw new Error(malformed);
  return output.slice(0, -1);
}

export function parsePostgresCanonicalIdentity(output) {
  const identity = parsePsqlSingleRow(
    output,
    "postgres_gate_identity_malformed",
  );
  if (!gateValue.test(identity))
    throw new Error("postgres_gate_identity_malformed");
  return identity;
}

export async function proveConcurrentPostgresReplay({
  attempt,
  expectedIdentity,
}) {
  if (typeof attempt !== "function" || !gateValue.test(expectedIdentity))
    throw new Error("unsafe_postgres_replay_probe");
  const replay = () =>
    Promise.resolve().then(attempt).then(parsePostgresCanonicalIdentity);
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () => replay().catch((error) => error)),
  );
  const failures = duplicates.filter((result) => result instanceof Error);
  const nonSerializationFailure = failures.find(
    (error) => error?.code !== "40001",
  );
  if (nonSerializationFailure !== undefined) throw nonSerializationFailure;
  if (duplicates.every((result) => result instanceof Error))
    throw new Error("postgres_concurrent_duplicate_all_failed");
  if (
    duplicates.some(
      (result) => !(result instanceof Error) && result !== expectedIdentity,
    )
  )
    throw new Error("postgres_concurrent_duplicate_identity_unstable");
  const identities = await Promise.all(
    duplicates.map((result) => (result instanceof Error ? replay() : result)),
  );
  if (identities.some((identity) => identity !== expectedIdentity))
    throw new Error("postgres_concurrent_duplicate_identity_unstable");
  return Object.freeze({
    attempts: duplicates.length,
    identity: expectedIdentity,
  });
}

export function postgresAtomicityProven(snapshot) {
  return (
    snapshot.receipts === 1 &&
    snapshot.workloads === 1 &&
    snapshot.outbox === 1 &&
    snapshot.acceptedHistory === 1 &&
    snapshot.workloadIds.length === 1
  );
}

export function crashWindowAcceptanceSql(input, outcomeWindow) {
  const sql = atomicAcceptanceSql(input);
  if (outcomeWindow === "before_commit")
    return sql.replace("COMMIT;", "SELECT pg_sleep(30);\nCOMMIT;");
  if (outcomeWindow === "after_commit") return `${sql}\nSELECT pg_sleep(30);`;
  throw new Error("postgres_crash_window_invalid");
}

async function executePsql(config, sql, timeoutMs = 20_000) {
  const result = await config.runner.run(
    config.psqlExecutable,
    psqlArguments({ ...config, sql }),
    {
      environment: { PGPASSWORD: config.password },
      timeoutMs,
    },
  );
  if (result.code !== 0) throw postgresCommandError(result);
  return result.stdout;
}

async function waitForCrashWindow(config, applicationName) {
  const deadline = Date.now() + 8_000;
  const sql = `SELECT count(*) FROM pg_stat_activity WHERE application_name = ${literal(applicationName)} AND state = 'active' AND query LIKE '%pg_sleep%';`;
  for (;;) {
    if (
      parsePsqlSingleRow(
        await executePsql(config, sql, 2_000),
        "postgres_crash_window_observation_malformed",
      ) === "1"
    )
      return;
    if (Date.now() >= deadline)
      throw new Error("postgres_crash_window_not_synchronized");
    await config.wait(25);
  }
}

async function startCrashClient(config, input, window, applicationName) {
  const child = await config.runner.start(
    config.psqlExecutable,
    psqlArguments({
      ...config,
      sql: crashWindowAcceptanceSql(input, window),
    }),
    {
      environment: {
        PGAPPNAME: applicationName,
        PGPASSWORD: config.password,
      },
      timeoutMs: 12_000,
    },
  );
  await waitForCrashWindow(config, applicationName);
  return child;
}

export async function runPostgresFixtureProbe(config) {
  const version = parsePsqlSingleRow(
    await executePsql(config, "SHOW server_version;"),
    "postgres_fixture_version_output_malformed",
  );
  if (!/^18\.4(?:\s|$)/u.test(version))
    throw new Error("postgres_fixture_version_mismatch");
  await executePsql(config, postgresSchemaSql(config.schema));
  const acceptance = {
    callerScope: "gate-caller",
    idempotencyKey: "gate-idempotency",
    operationId: "gate-operation",
    schema: config.schema,
    workloadId: "gate-workload",
  };
  const concurrentReplay = await proveConcurrentPostgresReplay({
    attempt: () => executePsql(config, atomicAcceptanceSql(acceptance)),
    expectedIdentity: acceptance.workloadId,
  });
  const initial = parsePostgresSnapshot(
    await executePsql(config, postgresSnapshotSql(config.schema)),
  );
  if (!postgresAtomicityProven(initial))
    throw new Error("postgres_atomicity_not_proven");
  await executePsql(config, terminalHistorySql(acceptance));

  const beforeCommitInput = {
    callerScope: "gate-before-commit-caller",
    idempotencyKey: "gate-before-commit-idempotency",
    operationId: "gate-before-commit-operation",
    schema: config.schema,
    workloadId: "gate-before-commit-workload",
  };
  const beforeCommit = await startCrashClient(
    config,
    beforeCommitInput,
    "before_commit",
    "wf-gate-before-commit",
  );
  const beforeCommitCrash = await config.crashServer(beforeCommit);
  const afterBeforeCommit = parsePostgresSnapshot(
    await executePsql(config, postgresSnapshotSql(config.schema)),
  );
  if (
    afterBeforeCommit.workloads !== 1 ||
    afterBeforeCommit.workloadIds.includes(beforeCommitInput.workloadId)
  )
    throw new Error("postgres_precommit_crash_was_not_rolled_back");

  const afterCommitInput = {
    callerScope: "gate-after-commit-caller",
    idempotencyKey: "gate-after-commit-idempotency",
    operationId: "gate-after-commit-operation",
    schema: config.schema,
    workloadId: "gate-after-commit-workload",
  };
  const afterCommit = await startCrashClient(
    config,
    afterCommitInput,
    "after_commit",
    "wf-gate-after-commit",
  );
  const committedBeforeKill = parsePostgresSnapshot(
    await executePsql(config, postgresSnapshotSql(config.schema)),
  );
  if (
    committedBeforeKill.workloads !== 2 ||
    !committedBeforeKill.workloadIds.includes(afterCommitInput.workloadId)
  )
    throw new Error("postgres_postcommit_window_not_proven");
  const afterCommitCrash = await config.crashServer(afterCommit);

  const afterRestart = parsePostgresSnapshot(
    await executePsql(config, postgresSnapshotSql(config.schema)),
  );
  const stable = parsePostgresSnapshot(
    await executePsql(config, postgresSnapshotSql(config.schema)),
  );
  const relationsAtomic =
    stable.receipts === stable.workloads &&
    stable.workloads === stable.outbox &&
    stable.outbox === stable.acceptedHistory &&
    new Set(stable.workloadIds).size === stable.workloadIds.length;
  if (
    JSON.stringify(afterRestart) !== JSON.stringify(stable) ||
    stable.workloads !== 2 ||
    stable.terminalHistory !== 1 ||
    !relationsAtomic
  )
    throw new Error("postgres_crash_restart_state_unstable");
  return Object.freeze({
    concurrentDuplicateAttempts: concurrentReplay.attempts,
    concurrentDuplicateIdentity: concurrentReplay.identity,
    crashWindows: Object.freeze({
      postCommitCrash: afterCommitCrash,
      postCommitPersistedAfterRestart: true,
      postCommitSynchronizedBeforeKill: true,
      preCommitCrash: beforeCommitCrash,
      preCommitRolledBackAfterRestart: true,
      preCommitSynchronizedBeforeKill: true,
    }),
    database: config.database,
    historyPreserved: true,
    schema: config.schema,
    snapshot: stable,
    version,
  });
}
