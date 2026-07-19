import type {
  Attempt,
  Run,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { PostgresLifecycleError } from "./postgres-errors.js";
import type { PostgresPoolRuntime } from "./postgres-pool.js";
import {
  appendCanonicalAudit,
  completeCanonicalInbox,
  tupleDigest,
} from "./canonical-bundle-writes.js";

interface ErasureInput {
  readonly operationId: string;
  readonly pseudonym: string;
  readonly subjectPrincipalId: string;
  readonly tenantId: string;
}

interface CountRow extends Record<string, unknown> {
  readonly changed_count: number;
  readonly pseudonym: string;
  readonly subject_principal_id: string;
  readonly tenant_id: string;
}

function validVersion(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

export class LifecycleWrites {
  public constructor(
    private readonly pool: PostgresPoolRuntime,
    private readonly schema: string,
  ) {}

  public async saveAttempt(
    attempt: Attempt,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !validVersion(expectedVersion) ||
      !validVersion(attempt.version) ||
      attempt.version !== expectedVersion + 1
    )
      throw new PostgresLifecycleError("postgres_lifecycle_conflict");
    await this.pool.transaction(
      async (client) => {
        const result = await client.query(
          `UPDATE ${this.schema}.lifecycle_attempt SET
             state = $2, cancellation_desired = $3,
             start_authorization = $4, start_fence = $5,
             start_revocation_revision = $6, allocation_id = $7,
             dispatch_id = $8, execution_id = $9, result_manifest_id = $10,
             terminalization_intent = $11::jsonb,
             terminal_release_receipt_id = $12, attachment_rejections = $13,
             reservation_request_revision = $14, version = $15
           WHERE attempt_id = $1 AND version = $16
             AND run_id = $17 AND execution_generation = $18`,
          [
            attempt.attemptId,
            attempt.state,
            attempt.cancellationDesired,
            attempt.startAuthorization,
            attempt.startFence,
            attempt.startRevocationRevision,
            attempt.allocationId ?? null,
            attempt.dispatchId ?? null,
            attempt.executionId ?? null,
            attempt.resultManifestId ?? null,
            attempt.terminalizationIntent === undefined
              ? null
              : JSON.stringify(attempt.terminalizationIntent),
            attempt.terminalReleaseReceiptId ?? null,
            attempt.attachmentRejections,
            attempt.reservationRequestRevision,
            attempt.version,
            expectedVersion,
            attempt.runId,
            attempt.executionGeneration,
          ],
          signal,
        );
        if (result.rowCount !== 1)
          throw new PostgresLifecycleError("postgres_lifecycle_conflict");
      },
      signal === undefined ? {} : { signal },
    );
  }

  public async saveRun(
    run: Run,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      !validVersion(expectedVersion) ||
      !validVersion(run.version) ||
      run.version !== expectedVersion + 1
    )
      throw new PostgresLifecycleError("postgres_lifecycle_conflict");
    await this.pool.transaction(
      async (client) => {
        const result = await client.query(
          `UPDATE ${this.schema}.lifecycle_run SET
             cancellation_desired = $2, state = $3,
             terminal_outcome = $4, version = $5
           WHERE run_id = $1 AND version = $6
             AND workload_id = $7 AND attempt_id = $8`,
          [
            run.runId,
            run.cancellationDesired,
            run.state,
            run.terminalOutcome ?? null,
            run.version,
            expectedVersion,
            run.workloadId,
            run.attemptId,
          ],
          signal,
        );
        if (result.rowCount !== 1)
          throw new PostgresLifecycleError("postgres_lifecycle_conflict");
      },
      signal === undefined ? {} : { signal },
    );
  }

  public erasePrincipalReferences(
    input: ErasureInput,
    signal?: AbortSignal,
  ): Promise<number> {
    return this.pool.transaction(
      async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`workload-funnel:lifecycle-erasure:${input.operationId}`],
          signal,
        );
        const prior = await client.query<CountRow>(
          `SELECT changed_count, tenant_id, subject_principal_id, pseudonym
             FROM ${this.schema}.lifecycle_erasure
            WHERE operation_id = $1
            FOR UPDATE`,
          [input.operationId],
          signal,
        );
        const priorRow = prior.rows[0];
        if (priorRow !== undefined) {
          if (
            priorRow.tenant_id !== input.tenantId ||
            priorRow.subject_principal_id !== input.subjectPrincipalId ||
            priorRow.pseudonym !== input.pseudonym
          )
            throw new PostgresLifecycleError(
              "postgres_lifecycle_idempotency_conflict",
            );
          return priorRow.changed_count;
        }
        const updated = await client.query(
          `UPDATE ${this.schema}.lifecycle_workload
              SET principal_id = $3,
                  spec = jsonb_set(
                    jsonb_set(spec, '{command}', '["[erased]"]'::jsonb),
                    '{resultFiles}', '[]'::jsonb
                  )
            WHERE tenant_id = $1 AND principal_id = $2`,
          [input.tenantId, input.subjectPrincipalId, input.pseudonym],
          signal,
        );
        const changed = updated.rowCount ?? 0;
        await client.query(
          `INSERT INTO ${this.schema}.lifecycle_erasure
             (operation_id, tenant_id, subject_principal_id,
              pseudonym, changed_count)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            input.operationId,
            input.tenantId,
            input.subjectPrincipalId,
            input.pseudonym,
            changed,
          ],
          signal,
        );
        await completeCanonicalInbox(
          client,
          this.schema,
          {
            consumerId: "control-api",
            messageId: input.operationId,
            operationKind: "erasure",
            payloadDigest: tupleDigest([
              input.tenantId,
              input.subjectPrincipalId,
              input.pseudonym,
            ]),
          },
          signal,
        );
        await appendCanonicalAudit(
          client,
          this.schema,
          {
            action: "principal.references-erased",
            actorId: input.subjectPrincipalId,
            details: Object.freeze({
              changedCount: changed,
              pseudonym: input.pseudonym,
            }),
            eventId: `audit:${input.operationId}`,
            resourceId: input.subjectPrincipalId,
            tenantId: input.tenantId,
          },
          signal,
        );
        return changed;
      },
      signal === undefined ? {} : { signal },
    );
  }
}
