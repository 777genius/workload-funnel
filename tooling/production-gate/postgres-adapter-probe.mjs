let createAsyncWorkloadLifecycleService;
let createPostgresLifecycleDatabase;
let migratePostgresLifecycleSchema;
let authenticatedCallerScope;

async function loadBuiltAdapter() {
  const [persistence, migrations, lifecycle] = await Promise.all([
    import("../../packages/store-postgres/dist/features/workload-persistence/index.js"),
    import("../../packages/store-postgres/dist/features/schema-migrations/index.js"),
    import("../../packages/workload-control/dist/features/workload-lifecycle/index.js"),
  ]);
  createPostgresLifecycleDatabase = persistence.createPostgresLifecycleDatabase;
  migratePostgresLifecycleSchema = migrations.migratePostgresLifecycleSchema;
  createAsyncWorkloadLifecycleService =
    lifecycle.createAsyncWorkloadLifecycleService;
  authenticatedCallerScope = lifecycle.authenticatedCallerScope;
}

const principal = Object.freeze({
  namespaceId: "gate-namespace",
  principalId: "gate:principal",
  tenantId: "gate-tenant",
});

function scope(identity = principal) {
  return authenticatedCallerScope(identity);
}

function spec(command = "adapter-probe") {
  return Object.freeze({
    command: Object.freeze([command]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis: 100, memoryMiB: 64 }),
    resultFiles: Object.freeze([]),
    schemaVersion: 1,
    syntheticOutcome: "succeeded",
  });
}

function adapterConfig(connection, schema, overrides = {}) {
  return Object.freeze({
    applicationName: "workload-funnel-gate-adapter",
    connectionTimeoutMs: 1_000,
    database: connection.database,
    host: connection.host,
    idleTimeoutMs: 1_000,
    lockTimeoutMs: 1_000,
    maxConnections: 4,
    password: connection.password,
    port: connection.port,
    profile: "disposable-test",
    queryTimeoutMs: 3_000,
    schema,
    schemaOwner: connection.user,
    shutdownTimeoutMs: 2_000,
    statementTimeoutMs: 2_000,
    tls: false,
    user: connection.user,
    ...overrides,
  });
}

async function migrate(database) {
  await migratePostgresLifecycleSchema({
    executor: database.migrationExecutor,
    owner: database.schemaOwner,
    schema: database.schema,
  });
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

async function expectCode(work, code) {
  try {
    await work();
  } catch (error) {
    if (error?.code === code) return;
    throw error;
  }
  throw new Error(`expected_${code}`);
}

async function expectName(work, name) {
  try {
    await work();
  } catch (error) {
    if (error?.name === name) return;
    throw error;
  }
  throw new Error(`expected_${name}`);
}

async function migrationConcurrency(connection, schema, opened, trace) {
  const left = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
    trace: { append: (event) => trace.push(event) },
  });
  const right = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
  });
  opened.push(left, right);
  await Promise.all([migrate(left), migrate(right)]);
  return left;
}

async function migrationCorruption(connection, schema, opened) {
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
  });
  opened.push(database);
  await migrate(database);
  await database.migrationExecutor.transaction((client) =>
    client.query(
      `UPDATE ${schema}.schema_migration SET checksum = $1 WHERE version = 1`,
      ["0".repeat(64)],
    ),
  );
  await expectCode(() => migrate(database), "postgres_migration_corrupt");
}

async function lifecycleAdversaries(database) {
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  const command = Object.freeze({
    idempotencyKey: "adapter-duplicate",
    spec: spec(),
  });
  const duplicates = await Promise.all(
    Array.from({ length: 8 }, () => lifecycle.submit(principal, command)),
  );
  assert(
    new Set(duplicates.map((receipt) => receipt.workloadId)).size === 1,
    "postgres_adapter_duplicate_identity_unstable",
  );
  const receipt = duplicates[0];
  assert(receipt !== undefined, "postgres_adapter_receipt_missing");
  const counts = await database.migrationExecutor.transaction(
    async (client) =>
      (
        await client.query(
          `SELECT
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_acceptance) AS acceptances,
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_attempt) AS attempts,
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_operation) AS operations,
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_outbox) AS outbox,
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_run) AS runs,
           (SELECT count(*)::integer FROM ${database.schema}.lifecycle_workload) AS workloads`,
        )
      ).rows[0],
  );
  assert(
    counts !== undefined && Object.values(counts).every((count) => count === 1),
    "postgres_adapter_acceptance_not_atomic",
  );
  await expectCode(
    () =>
      lifecycle.submit(principal, {
        idempotencyKey: command.idempotencyKey,
        spec: spec("conflicting-command"),
      }),
    "postgres_lifecycle_idempotency_conflict",
  );
  const delimiterCollisionPrincipal = Object.freeze({
    namespaceId: "gate-namespace:gate",
    principalId: "principal",
    tenantId: principal.tenantId,
  });
  const crossTenantPrincipal = Object.freeze({
    ...principal,
    tenantId: "gate-tenant-other",
  });
  assert(
    `${principal.namespaceId}:${principal.principalId}` ===
      `${delimiterCollisionPrincipal.namespaceId}:${delimiterCollisionPrincipal.principalId}` &&
      scope(principal) !== scope(delimiterCollisionPrincipal) &&
      scope(principal) !== scope(crossTenantPrincipal),
    "postgres_adapter_caller_scope_encoding_collision",
  );
  const [delimiterReceipt, crossTenantReceipt] = await Promise.all([
    lifecycle.submit(delimiterCollisionPrincipal, command),
    lifecycle.submit(crossTenantPrincipal, command),
  ]);
  assert(
    new Set([
      receipt.workloadId,
      delimiterReceipt.workloadId,
      crossTenantReceipt.workloadId,
    ]).size === 3 &&
      new Set([
        receipt.operationId,
        delimiterReceipt.operationId,
        crossTenantReceipt.operationId,
      ]).size === 3,
    "postgres_adapter_caller_scope_idempotency_collision",
  );
  const targetRunBefore = await database.repository.getRun(receipt.runId);
  const targetAttemptBefore = await database.repository.getAttempt(
    receipt.attemptId,
  );
  for (const adversary of [delimiterCollisionPrincipal, crossTenantPrincipal]) {
    assert(
      (await lifecycle.status(adversary, receipt.runId)) === undefined &&
        (await lifecycle.operationStatus(adversary, receipt.operationId)) ===
          undefined,
      "postgres_adapter_cross_scope_read_disclosure",
    );
    await expectCode(
      () => lifecycle.cancel(adversary, receipt.runId, "adapter-cancel"),
      "postgres_lifecycle_not_found",
    );
  }
  assert(
    JSON.stringify(await database.repository.getRun(receipt.runId)) ===
      JSON.stringify(targetRunBefore) &&
      JSON.stringify(
        await database.repository.getAttempt(receipt.attemptId),
      ) === JSON.stringify(targetAttemptBefore),
    "postgres_adapter_cross_scope_cancel_mutated_target",
  );
  const [delimiterCancellation, crossTenantCancellation] = await Promise.all([
    lifecycle.cancel(
      delimiterCollisionPrincipal,
      delimiterReceipt.runId,
      "adapter-cancel",
    ),
    lifecycle.cancel(
      crossTenantPrincipal,
      crossTenantReceipt.runId,
      "adapter-cancel",
    ),
  ]);
  assert(
    delimiterCancellation.operationId !== crossTenantCancellation.operationId,
    "postgres_adapter_cancellation_identity_collision",
  );
  const [operation, workload, run, attempt, status] = await Promise.all([
    database.repository.findOperation(scope(), command.idempotencyKey),
    database.repository.getWorkload(receipt.workloadId),
    database.repository.getRun(receipt.runId),
    database.repository.getAttempt(receipt.attemptId),
    database.repository.getStatus(scope(), receipt.runId),
  ]);
  assert(
    operation?.operationId === receipt.operationId &&
      workload?.workloadId === receipt.workloadId &&
      run?.runId === receipt.runId &&
      attempt?.attemptId === receipt.attemptId &&
      status?.run.runId === receipt.runId,
    "postgres_adapter_exact_lookup_failed",
  );
  const activeRun = Object.freeze({ ...run, state: "active", version: 2 });
  await database.repository.saveRun(activeRun, 1);
  await expectCode(
    () => database.repository.saveRun(activeRun, 1),
    "postgres_lifecycle_conflict",
  );
  const admittedAttempt = Object.freeze({
    ...attempt,
    state: "admitted",
    version: 2,
  });
  await database.repository.saveAttempt(admittedAttempt, 1);
  await expectCode(
    () => database.repository.saveAttempt(admittedAttempt, 1),
    "postgres_lifecycle_conflict",
  );
  const cancellation = await lifecycle.cancel(
    principal,
    receipt.runId,
    "adapter-cancel",
  );
  const duplicateCancellation = await lifecycle.cancel(
    principal,
    receipt.runId,
    "adapter-cancel",
  );
  const cancellationOperation = await database.repository.getOperation(
    scope(),
    cancellation.operationId,
  );
  const [canceledRun, canceledAttempt] = await Promise.all([
    database.repository.getRun(receipt.runId),
    database.repository.getAttempt(receipt.attemptId),
  ]);
  assert(
    JSON.stringify(cancellation) === JSON.stringify(duplicateCancellation) &&
      cancellationOperation?.kind === "cancel" &&
      cancellationOperation.resourceId === receipt.runId &&
      canceledRun?.cancellationDesired === "requested" &&
      canceledRun.version === 3 &&
      canceledAttempt?.cancellationDesired === "requested" &&
      canceledAttempt.version === 3 &&
      (await database.repository.getCancellation(cancellation.operationId))
        ?.runId === receipt.runId,
    "postgres_adapter_cancellation_lookup_failed",
  );
  const second = await lifecycle.submit(principal, {
    idempotencyKey: "adapter-second",
    spec: spec("second"),
  });
  await expectCode(
    () =>
      database.repository.cancel(
        scope(),
        second.runId,
        cancellation.operationId,
      ),
    "postgres_lifecycle_idempotency_conflict",
  );
  const erasureSubject = Object.freeze({
    namespaceId: "gate-erasure",
    principalId: "shared-subject",
    tenantId: "gate-erasure-a",
  });
  const sameTenantForeignSubject = Object.freeze({
    ...erasureSubject,
    principalId: "same-tenant-foreign-subject",
  });
  const otherTenantSubject = Object.freeze({
    ...erasureSubject,
    tenantId: "gate-erasure-b",
  });
  const [erasureTarget, sameTenantForeignTarget, otherTenantTarget] =
    await Promise.all([
      lifecycle.submit(erasureSubject, {
        idempotencyKey: "erasure-target",
        spec: spec("erase-a"),
      }),
      lifecycle.submit(sameTenantForeignSubject, {
        idempotencyKey: "erasure-target",
        spec: spec("erase-same-tenant-foreign"),
      }),
      lifecycle.submit(otherTenantSubject, {
        idempotencyKey: "erasure-target",
        spec: spec("erase-b"),
      }),
    ]);
  const erasureInput = Object.freeze({
    operationId: "adapter-erasure-operation",
    pseudonym: "erased-subject",
    subjectPrincipalId: erasureSubject.principalId,
  });
  await expectName(
    () =>
      lifecycle.erasePrincipalReferences(erasureSubject, {
        operationId: "adapter-erasure-foreign-denied",
        pseudonym: "must-not-apply",
        subjectPrincipalId: sameTenantForeignSubject.principalId,
      }),
    "InvalidWorkloadError",
  );
  const changed = await lifecycle.erasePrincipalReferences(
    erasureSubject,
    erasureInput,
  );
  assert(
    changed === 1 &&
      (await lifecycle.erasePrincipalReferences(
        erasureSubject,
        erasureInput,
      )) === changed,
    "postgres_adapter_erasure_idempotency_failed",
  );
  await expectCode(
    () =>
      lifecycle.erasePrincipalReferences(erasureSubject, {
        ...erasureInput,
        pseudonym: "different-pseudonym",
      }),
    "postgres_lifecycle_idempotency_conflict",
  );
  const [erasedWorkload, sameTenantPreserved, otherTenantPreserved] =
    await Promise.all([
      database.repository.getWorkload(erasureTarget.workloadId),
      database.repository.getWorkload(sameTenantForeignTarget.workloadId),
      database.repository.getWorkload(otherTenantTarget.workloadId),
    ]);
  assert(
    erasedWorkload?.principalId === erasureInput.pseudonym &&
      erasedWorkload.spec.command[0] === "[erased]" &&
      erasedWorkload.spec.resultFiles.length === 0 &&
      sameTenantPreserved?.principalId ===
        sameTenantForeignSubject.principalId &&
      sameTenantPreserved.spec.command[0] === "erase-same-tenant-foreign" &&
      otherTenantPreserved?.principalId === otherTenantSubject.principalId &&
      otherTenantPreserved.spec.command[0] === "erase-b",
    "postgres_adapter_erasure_scope_violation",
  );
  await expectName(
    () => lifecycle.status({ ...principal, tenantId: "" }, receipt.runId),
    "InvalidWorkloadError",
  );
  await expectName(
    () =>
      lifecycle.erasePrincipalReferences(erasureSubject, {
        ...erasureInput,
        pseudonym: "",
      }),
    "InvalidWorkloadError",
  );
  return receipt;
}

async function rollbackProbe(connection, schema, opened) {
  let armed = true;
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
    faults: {
      async hit({ boundary }) {
        if (armed && boundary === "after_writes") {
          armed = false;
          throw new Error("synthetic_rollback_boundary");
        }
      },
    },
  });
  opened.push(database);
  await migrate(database);
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  await expectCode(
    () =>
      lifecycle.submit(principal, {
        idempotencyKey: "adapter-rollback",
        spec: spec("rollback"),
      }),
    "postgres_lifecycle_operation_failed",
  );
  assert(
    (await database.repository.findOperation(scope(), "adapter-rollback")) ===
      undefined,
    "postgres_adapter_rollback_visible",
  );
  const residue = await database.migrationExecutor.transaction(
    async (client) =>
      (
        await client.query(
          `SELECT
           (SELECT count(*)::integer FROM ${schema}.lifecycle_acceptance) +
           (SELECT count(*)::integer FROM ${schema}.lifecycle_attempt) +
           (SELECT count(*)::integer FROM ${schema}.lifecycle_operation) +
           (SELECT count(*)::integer FROM ${schema}.lifecycle_outbox) +
           (SELECT count(*)::integer FROM ${schema}.lifecycle_run) +
           (SELECT count(*)::integer FROM ${schema}.lifecycle_workload)
           AS canonical_rows`,
        )
      ).rows[0]?.canonical_rows,
  );
  assert(residue === 0, "postgres_adapter_rollback_residue");
}

async function connectionLossProbe(connection, schema, boundary, opened) {
  let armed = true;
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
    faults: {
      async hit(input) {
        if (armed && input.boundary === boundary) {
          armed = false;
          return "terminate_connection";
        }
      },
    },
  });
  opened.push(database);
  await migrate(database);
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  const command = Object.freeze({
    idempotencyKey: `adapter-${boundary}`,
    spec: spec(boundary),
  });
  const receipt = await lifecycle.submit(principal, command);
  assert(
    (await database.repository.getOperation(scope(), receipt.operationId))
      ?.resourceId === receipt.runId,
    `postgres_adapter_${boundary}_reconciliation_failed`,
  );
  await database.close();
  const reopened = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
  });
  opened.push(reopened);
  await migrate(reopened);
  const afterRestart = await createAsyncWorkloadLifecycleService(
    reopened.repository,
  ).submit(principal, command);
  assert(
    JSON.stringify(afterRestart) === JSON.stringify(receipt),
    `postgres_adapter_${boundary}_restart_reconciliation_failed`,
  );
}

async function callerAbortAfterCommitProbe(connection, schema, opened) {
  const controller = new globalThis.AbortController();
  let armed = true;
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
    faults: {
      async hit({ boundary }) {
        if (armed && boundary === "after_commit") {
          armed = false;
          controller.abort();
          throw new Error("synthetic_abort_after_commit_acknowledgement");
        }
      },
    },
  });
  opened.push(database);
  await migrate(database);
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  const command = Object.freeze({
    idempotencyKey: "adapter-abort-after-commit",
    spec: spec("abort-after-commit"),
  });
  const receipt = await lifecycle.submit(principal, command, {
    signal: controller.signal,
  });
  const replay = await lifecycle.submit(principal, command);
  const counts = await database.migrationExecutor.transaction(
    async (client) =>
      (
        await client.query(
          `SELECT
           (SELECT count(*)::integer FROM ${schema}.lifecycle_acceptance) AS acceptances,
           (SELECT count(*)::integer FROM ${schema}.lifecycle_operation) AS operations,
           (SELECT count(*)::integer FROM ${schema}.lifecycle_outbox) AS outbox`,
        )
      ).rows[0],
  );
  assert(
    controller.signal.aborted === true &&
      JSON.stringify(replay) === JSON.stringify(receipt) &&
      counts?.acceptances === 1 &&
      counts.operations === 1 &&
      counts.outbox === 1,
    "postgres_adapter_abort_after_commit_reconciliation_failed",
  );
}

async function poolBoundsProbe(connection, schema, opened) {
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  let releaseResolve;
  const release = new Promise((resolve) => {
    releaseResolve = resolve;
  });
  let armed = true;
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema, {
      connectionTimeoutMs: 100,
      lockTimeoutMs: 100,
      maxConnections: 1,
      queryTimeoutMs: 300,
      statementTimeoutMs: 250,
    }),
    faults: {
      async hit({ boundary }) {
        if (armed && boundary === "after_begin") {
          armed = false;
          enteredResolve();
          await release;
        }
      },
    },
  });
  opened.push(database);
  await migrate(database);
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  const blocked = lifecycle.submit(principal, {
    idempotencyKey: "adapter-pool-bound",
    spec: spec("pool-bound"),
  });
  await entered;
  await expectCode(
    () => database.repository.getOperation(scope(), "missing-operation"),
    "postgres_lifecycle_pool_timeout",
  );
  const waitingController = new globalThis.AbortController();
  const waitingRead = database.repository.getOperation(
    scope(),
    "missing-operation",
    { signal: waitingController.signal },
  );
  waitingController.abort();
  await expectCode(() => waitingRead, "postgres_lifecycle_aborted");
  releaseResolve();
  await blocked;
  await expectCode(
    () =>
      database.migrationExecutor.transaction((client) =>
        client.query("SELECT pg_sleep(5)"),
      ),
    "57014",
  );
  const controller = new globalThis.AbortController();
  controller.abort();
  await expectCode(
    () =>
      database.repository.getOperation(scope(), "missing-operation", {
        signal: controller.signal,
      }),
    "postgres_lifecycle_aborted",
  );
}

async function credentialRedactionProbe(connection, schema, opened) {
  const credential = `gate-secret-${Date.now().toString(16)}`;
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema, {
      password: credential,
    }),
  });
  opened.push(database);
  const failures = [];
  for (const work of [
    () => database.repository.getOperation(scope(), "missing-operation"),
    () => migrate(database),
  ]) {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  }
  assert(failures.length === 2, "postgres_adapter_bad_credential_accepted");
  const rendered = failures
    .map(
      (error) =>
        `${String(error)}\n${JSON.stringify(error)}\n${error?.stack ?? ""}`,
    )
    .join("\n");
  assert(!rendered.includes(credential), "postgres_adapter_credential_leaked");
}

async function deterministicShutdownProbe(connection, schema, opened) {
  let enteredResolve;
  const entered = new Promise((resolve) => {
    enteredResolve = resolve;
  });
  const database = createPostgresLifecycleDatabase({
    config: adapterConfig(connection, schema),
    faults: {
      async hit({ boundary }) {
        if (boundary === "after_begin") {
          enteredResolve();
          await new Promise(() => undefined);
        }
      },
    },
  });
  opened.push(database);
  await migrate(database);
  const lifecycle = createAsyncWorkloadLifecycleService(database.repository);
  const active = lifecycle.submit(principal, {
    idempotencyKey: "adapter-shutdown",
    spec: spec("shutdown"),
  });
  await entered;
  const closing = database.close();
  await expectCode(() => active, "postgres_lifecycle_closed");
  await closing;
}

export async function runPostgresLifecycleAdapterProbe(connection) {
  await loadBuiltAdapter();
  const suffix = connection.database.slice("wf_production_gate_".length);
  const schema = `wf_pg_${suffix}`;
  const opened = [];
  const transactionTrace = [];
  try {
    const database = await migrationConcurrency(
      connection,
      schema,
      opened,
      transactionTrace,
    );
    assert(
      database.driverVersion === "8.22.0",
      "postgres_adapter_driver_version_mismatch",
    );
    const receipt = await lifecycleAdversaries(database);
    assert(
      transactionTrace.includes("BEGIN ISOLATION LEVEL SERIALIZABLE") &&
        transactionTrace.includes(
          "LOCK acceptance_idempotency SELECT pg_advisory_xact_lock",
        ) &&
        transactionTrace.includes("COMMIT") &&
        transactionTrace.includes("ROLLBACK"),
      "postgres_adapter_transaction_lock_trace_incomplete",
    );
    await rollbackProbe(connection, `${schema}_rollback`, opened);
    await connectionLossProbe(
      connection,
      `${schema}_precommit`,
      "before_commit",
      opened,
    );
    await connectionLossProbe(
      connection,
      `${schema}_postcommit`,
      "after_commit",
      opened,
    );
    await callerAbortAfterCommitProbe(
      connection,
      `${schema}_abort_postcommit`,
      opened,
    );
    await poolBoundsProbe(connection, `${schema}_pool`, opened);
    await deterministicShutdownProbe(connection, `${schema}_shutdown`, opened);
    await migrationCorruption(connection, `${schema}_corrupt`, opened);
    await database.close();
    const reopened = createPostgresLifecycleDatabase({
      config: adapterConfig(connection, schema),
    });
    opened.push(reopened);
    await migrate(reopened);
    assert(
      (await reopened.repository.getStatus(scope(), receipt.runId))?.run
        .runId === receipt.runId,
      "postgres_adapter_restart_reopen_failed",
    );
    await credentialRedactionProbe(connection, `${schema}_credential`, opened);
    return Object.freeze({
      abortSignalProven: true,
      callerAbortAfterCommitReconciled: true,
      ambiguousCommitReconciled: Object.freeze({
        postCommit: true,
        preCommit: true,
        restart: true,
      }),
      atomicAcceptanceProven: true,
      callerScopeAuthorizationProven: true,
      callerScopeDelimiterAndTenantIsolationProven: true,
      credentialRedactionProven: true,
      duplicateAndConflictProven: true,
      deterministicShutdownProven: true,
      exactLookupProven: true,
      erasureSelfAuthorizationProven: true,
      erasureTupleIdempotencyAndTenantIsolationProven: true,
      lifecycleInputValidationProven: true,
      migrationConcurrencyAndCorruptionProven: true,
      optimisticConflictProven: true,
      pgDriverVersion: database.driverVersion,
      poolExhaustionTimeoutProven: true,
      queryTimeoutProven: true,
      restartReopenProven: true,
      rollbackProven: true,
      schema,
      statusAtomicSnapshotProven: true,
      transactionLockTraceProven: true,
    });
  } finally {
    await Promise.allSettled(opened.map((database) => database.close()));
  }
}
