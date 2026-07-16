import type {
  AcceptanceInput,
  AcceptanceReceipt,
} from "@workload-funnel/workload-control/workload-lifecycle";
import { lifecycleOperationId } from "@workload-funnel/workload-control/workload-lifecycle";

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
import { decodeAcceptance, type AcceptanceRow } from "./row-codecs.js";

interface SequenceRow extends Record<string, unknown> {
  readonly sequence_id: string;
}

interface AcceptanceRuntime {
  readonly faults?: PostgresLifecycleFaultInjector;
  readonly pool: PostgresPoolRuntime;
  readonly schema: string;
  readonly trace?: PostgresLifecycleTraceSink;
}

function suffixFromSequence(row: SequenceRow | undefined): string {
  if (row === undefined || !/^[1-9][0-9]*$/u.test(row.sequence_id))
    throw new PostgresLifecycleError("postgres_lifecycle_row_corrupt");
  return row.sequence_id.padStart(4, "0");
}

function assertMatchingDigest(
  row: AcceptanceRow,
  expectedDigest: string,
): AcceptanceReceipt {
  if (row.spec_digest !== expectedDigest)
    throw new PostgresLifecycleError("postgres_lifecycle_idempotency_conflict");
  return decodeAcceptance(row);
}

async function lockAcceptance(
  client: PostgresQueryClient,
  schema: string,
  input: AcceptanceInput,
): Promise<AcceptanceRow | undefined> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    lifecycleOperationId("submit", input.callerScope, input.idempotencyKey),
  ]);
  const result = await client.query<AcceptanceRow>(
    `SELECT attempt_id, execution_generation, operation_id, run_id,
            spec_digest, workload_id
       FROM ${schema}.lifecycle_acceptance
      WHERE caller_scope = $1 AND idempotency_key = $2
      FOR UPDATE`,
    [input.callerScope, input.idempotencyKey],
  );
  return result.rows[0];
}

async function insertAcceptance(
  client: PostgresQueryClient,
  schema: string,
  input: AcceptanceInput,
): Promise<AcceptanceReceipt> {
  const sequence = await client.query<SequenceRow>(
    `INSERT INTO ${schema}.lifecycle_identity DEFAULT VALUES
     RETURNING sequence_id::text`,
  );
  const suffix = suffixFromSequence(sequence.rows[0]);
  const workloadId = `workload-${suffix}`;
  const runId = `run-${suffix}`;
  const attemptId = `attempt-${suffix}`;
  const executionGeneration = `generation-${suffix}`;
  const operationId = lifecycleOperationId(
    "submit",
    input.callerScope,
    input.idempotencyKey,
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_workload
       (workload_id, tenant_id, principal_id, spec, spec_digest)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      workloadId,
      input.tenantId,
      input.principalId,
      JSON.stringify(input.spec),
      input.specDigest,
    ],
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_run
       (run_id, workload_id, attempt_id, cancellation_desired, state, version)
     VALUES ($1, $2, $3, 'none', 'accepted', 1)`,
    [runId, workloadId, attemptId],
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_attempt
       (attempt_id, run_id, execution_generation, state,
        cancellation_desired, start_authorization, start_fence,
        start_revocation_revision, attachment_rejections,
        reservation_request_revision, version)
     VALUES ($1, $2, $3, 'queued', 'none', 'authorized', $4, 0, 0, 0, 1)`,
    [attemptId, runId, executionGeneration, `start-fence-${suffix}`],
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_operation
       (operation_id, caller_scope, idempotency_key, kind, status, resource_id)
     VALUES ($1, $2, $3, 'submit', 'committed', $4)`,
    [operationId, input.callerScope, input.idempotencyKey, runId],
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_acceptance
       (caller_scope, idempotency_key, spec_digest, operation_id,
        workload_id, run_id, attempt_id, execution_generation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.callerScope,
      input.idempotencyKey,
      input.specDigest,
      operationId,
      workloadId,
      runId,
      attemptId,
      executionGeneration,
    ],
  );
  await client.query(
    `INSERT INTO ${schema}.lifecycle_outbox
       (message_id, operation_id, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, 'WorkloadAccepted', $4::jsonb)`,
    [
      `message:${operationId}`,
      operationId,
      workloadId,
      JSON.stringify({ attemptId, operationId, runId, workloadId }),
    ],
  );
  return Object.freeze({
    attemptId,
    duplicate: false,
    executionGeneration,
    operationId,
    runId,
    workloadId,
  });
}

async function reconcileAcceptance(
  runtime: AcceptanceRuntime,
  input: AcceptanceInput,
): Promise<AcceptanceReceipt | undefined> {
  return runtime.pool.reconcile(async (client) => {
    const result = await client.query<AcceptanceRow>(
      `SELECT attempt_id, execution_generation, operation_id, run_id,
              spec_digest, workload_id
         FROM ${runtime.schema}.lifecycle_acceptance
        WHERE caller_scope = $1 AND idempotency_key = $2`,
      [input.callerScope, input.idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : assertMatchingDigest(row, input.specDigest);
  });
}

export async function acceptPostgresLifecycle(
  runtime: AcceptanceRuntime,
  input: AcceptanceInput,
  signal?: AbortSignal,
): Promise<AcceptanceReceipt> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runtime.pool.transaction(
        async (client) => {
          runtime.trace?.append(
            "LOCK acceptance_idempotency SELECT pg_advisory_xact_lock",
          );
          const prior = await lockAcceptance(client, runtime.schema, input);
          return prior === undefined
            ? insertAcceptance(client, runtime.schema, input)
            : assertMatchingDigest(prior, input.specDigest);
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
          const reconciled = await reconcileAcceptance(runtime, input);
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
