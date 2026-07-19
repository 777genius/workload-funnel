import type { CancellationReceipt } from "@workload-funnel/workload-control/workload-lifecycle";

import {
  errorCode,
  isConnectionFailure,
  PostgresLifecycleError,
  sanitizePostgresError,
  TransactionFailure,
} from "./postgres-errors.js";
import type {
  PostgresLifecycleFaultInjector,
  PostgresLifecycleTraceSink,
  PostgresPoolRuntime,
  PostgresQueryClient,
} from "./postgres-pool.js";
import {
  decodeCancellation,
  type CancellationRow,
  type OperationRow,
  type RunRow,
} from "./row-codecs.js";
import {
  appendCanonicalAudit,
  completeCanonicalInbox,
  tupleDigest,
} from "./canonical-bundle-writes.js";

interface CancellationRuntime {
  readonly faults?: PostgresLifecycleFaultInjector;
  readonly pool: PostgresPoolRuntime;
  readonly schema: string;
  readonly trace?: PostgresLifecycleTraceSink;
}

interface OwnedOperationRow extends OperationRow {
  readonly caller_scope: string;
}

interface OwnedRunRow extends RunRow {
  readonly principal_id: string;
  readonly tenant_id: string;
}

async function existingCancellation(
  client: PostgresQueryClient,
  schema: string,
  callerScope: string,
  operationId: string,
  runId: string,
): Promise<CancellationReceipt | undefined> {
  const operation = await client.query<OwnedOperationRow>(
    `SELECT operation_id, caller_scope, kind, status, resource_id
       FROM ${schema}.lifecycle_operation
      WHERE operation_id = $1
      FOR UPDATE`,
    [operationId],
  );
  const row = operation.rows[0];
  if (row === undefined) return undefined;
  if (
    row.kind !== "cancel" ||
    row.resource_id !== runId ||
    row.caller_scope !== callerScope
  )
    throw new PostgresLifecycleError("postgres_lifecycle_idempotency_conflict");
  const cancellation = await client.query<CancellationRow>(
    `SELECT operation_id, run_id, status
       FROM ${schema}.lifecycle_cancellation
      WHERE operation_id = $1`,
    [operationId],
  );
  if (cancellation.rows[0] === undefined)
    throw new PostgresLifecycleError("postgres_lifecycle_row_corrupt");
  return decodeCancellation(cancellation.rows[0]);
}

async function createCancellation(
  client: PostgresQueryClient,
  schema: string,
  callerScope: string,
  operationId: string,
  runId: string,
): Promise<CancellationReceipt> {
  const runResult = await client.query<OwnedRunRow>(
    `SELECT r.run_id, r.workload_id, r.attempt_id, r.cancellation_desired,
            r.state, r.terminal_outcome, r.version,
            w.principal_id, w.tenant_id
       FROM ${schema}.lifecycle_run r
       JOIN ${schema}.lifecycle_acceptance a ON a.run_id = r.run_id
       JOIN ${schema}.lifecycle_workload w ON w.workload_id = r.workload_id
      WHERE r.run_id = $1 AND a.caller_scope = $2
      FOR UPDATE`,
    [runId, callerScope],
  );
  const run = runResult.rows[0];
  if (run === undefined)
    throw new PostgresLifecycleError("postgres_lifecycle_not_found");
  await client.query(
    `SELECT attempt_id
       FROM ${schema}.lifecycle_attempt
      WHERE attempt_id = $1
      FOR UPDATE`,
    [run.attempt_id],
  );
  const terminal = run.terminal_outcome !== null;
  if (!terminal) {
    const updatedRun = await client.query(
      `UPDATE ${schema}.lifecycle_run
          SET cancellation_desired = 'requested', version = version + 1
        WHERE run_id = $1 AND version = $2`,
      [runId, run.version],
    );
    const updatedAttempt = await client.query(
      `UPDATE ${schema}.lifecycle_attempt
          SET cancellation_desired = 'requested', version = version + 1
        WHERE attempt_id = $1`,
      [run.attempt_id],
    );
    if (updatedRun.rowCount !== 1 || updatedAttempt.rowCount !== 1)
      throw new PostgresLifecycleError("postgres_lifecycle_conflict");
  }
  await client.query(
    `INSERT INTO ${schema}.lifecycle_operation
       (operation_id, caller_scope, kind, status, resource_id)
     VALUES ($1, $2, 'cancel', 'committed', $3)`,
    [operationId, callerScope, runId],
  );
  const status = terminal ? "already_terminal" : "cancellation_requested";
  await client.query(
    `INSERT INTO ${schema}.lifecycle_cancellation
       (operation_id, run_id, status)
     VALUES ($1, $2, $3)`,
    [operationId, runId, status],
  );
  await completeCanonicalInbox(client, schema, {
    consumerId: "control-api",
    messageId: operationId,
    operationKind: "cancel",
    payloadDigest: tupleDigest([callerScope, runId, operationId]),
  });
  await appendCanonicalAudit(client, schema, {
    action: "run.cancellation-requested",
    actorId: run.principal_id,
    details: Object.freeze({ callerScope, status }),
    eventId: `audit:${operationId}`,
    resourceId: runId,
    tenantId: run.tenant_id,
  });
  if (!terminal) {
    await client.query(
      `INSERT INTO ${schema}.lifecycle_outbox
         (message_id, operation_id, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, 'RunCancellationRequested', $4::jsonb)`,
      [
        `message:${operationId}`,
        operationId,
        runId,
        JSON.stringify({ attemptId: run.attempt_id, operationId, runId }),
      ],
    );
  }
  return Object.freeze({ operationId, runId, status });
}

async function reconcileCancellation(
  runtime: CancellationRuntime,
  callerScope: string,
  operationId: string,
  runId: string,
): Promise<CancellationReceipt | undefined> {
  return runtime.pool.reconcile(async (client) => {
    const operation = await client.query<OwnedOperationRow>(
      `SELECT operation_id, caller_scope, kind, status, resource_id
         FROM ${runtime.schema}.lifecycle_operation
        WHERE operation_id = $1`,
      [operationId],
    );
    const row = operation.rows[0];
    if (row === undefined) return undefined;
    if (
      row.kind !== "cancel" ||
      row.resource_id !== runId ||
      row.caller_scope !== callerScope
    )
      throw new PostgresLifecycleError(
        "postgres_lifecycle_idempotency_conflict",
      );
    const cancellation = await client.query<CancellationRow>(
      `SELECT operation_id, run_id, status
         FROM ${runtime.schema}.lifecycle_cancellation
        WHERE operation_id = $1`,
      [operationId],
    );
    if (cancellation.rows[0] === undefined)
      throw new PostgresLifecycleError("postgres_lifecycle_row_corrupt");
    return decodeCancellation(cancellation.rows[0]);
  });
}

export async function cancelPostgresLifecycle(
  runtime: CancellationRuntime,
  callerScope: string,
  runId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<CancellationReceipt> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runtime.pool.transaction(
        async (client) => {
          runtime.trace?.append(
            "LOCK cancellation_operation SELECT pg_advisory_xact_lock",
          );
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [`workload-funnel:lifecycle-cancel:${operationId}`],
          );
          return (
            (await existingCancellation(
              client,
              runtime.schema,
              callerScope,
              operationId,
              runId,
            )) ??
            createCancellation(
              client,
              runtime.schema,
              callerScope,
              operationId,
              runId,
            )
          );
        },
        {
          ...(runtime.faults === undefined ? {} : { faults: runtime.faults }),
          ...(signal === undefined ? {} : { signal }),
          ...(runtime.trace === undefined ? {} : { trace: runtime.trace }),
        },
      );
    } catch (error) {
      const transaction =
        error instanceof TransactionFailure ? error : undefined;
      const raw = transaction?.original ?? error;
      if (errorCode(raw) === "40001" || errorCode(raw) === "40P01") {
        if (signal?.aborted === true)
          throw new PostgresLifecycleError("postgres_lifecycle_aborted");
        if (attempt < 2) continue;
        throw new PostgresLifecycleError("postgres_lifecycle_conflict");
      }
      if (transaction === undefined && isConnectionFailure(raw)) {
        if (signal?.aborted === true)
          throw new PostgresLifecycleError("postgres_lifecycle_aborted");
        if (attempt < 2) continue;
        throw sanitizePostgresError(raw);
      }
      if (
        transaction?.commitAttempted === true ||
        transaction?.commitAcknowledged === true ||
        (transaction !== undefined && isConnectionFailure(raw))
      ) {
        try {
          const reconciled = await reconcileCancellation(
            runtime,
            callerScope,
            operationId,
            runId,
          );
          if (reconciled !== undefined) return reconciled;
          if (signal?.aborted === true)
            throw new PostgresLifecycleError(
              transaction.commitAttempted
                ? "postgres_lifecycle_outcome_unknown"
                : "postgres_lifecycle_aborted",
            );
          if (attempt < 2) continue;
        } catch (reconciliationError) {
          const reconciliationRaw =
            reconciliationError instanceof TransactionFailure
              ? reconciliationError.original
              : reconciliationError;
          if (signal?.aborted === true)
            throw new PostgresLifecycleError(
              transaction.commitAttempted
                ? "postgres_lifecycle_outcome_unknown"
                : "postgres_lifecycle_aborted",
            );
          if (
            reconciliationRaw instanceof PostgresLifecycleError &&
            [
              "postgres_lifecycle_idempotency_conflict",
              "postgres_lifecycle_row_corrupt",
            ].includes(reconciliationRaw.code)
          )
            throw reconciliationRaw;
          if (attempt < 2) continue;
        }
        throw new PostgresLifecycleError("postgres_lifecycle_outcome_unknown");
      }
      throw sanitizePostgresError(error);
    }
  }
  throw new PostgresLifecycleError("postgres_lifecycle_outcome_unknown");
}
