import type {
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  Workload,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type {
  PostgresPoolRuntime,
  PostgresQueryClient,
} from "./postgres-pool.js";
import {
  decodeAttempt,
  decodeCancellation,
  decodeOperation,
  decodeRun,
  decodeWorkload,
  type AttemptRow,
  type CancellationRow,
  type OperationRow,
  type RunRow,
  type WorkloadRow,
} from "./row-codecs.js";

interface StatusRow extends Record<string, unknown> {
  readonly attempt: AttemptRow;
  readonly run: RunRow;
  readonly workload: WorkloadRow;
}

export class LifecycleReads {
  public constructor(
    private readonly pool: PostgresPoolRuntime,
    private readonly schema: string,
  ) {}

  public findOperation(
    callerScope: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<OperationStatus | undefined> {
    return this.pool.read(async (client) => {
      const result = await client.query<OperationRow>(
        `SELECT o.operation_id, o.kind, o.status, o.resource_id
           FROM ${this.schema}.lifecycle_acceptance a
           JOIN ${this.schema}.lifecycle_operation o
             ON o.operation_id = a.operation_id
          WHERE a.caller_scope = $1 AND a.idempotency_key = $2`,
        [callerScope, idempotencyKey],
        signal,
      );
      return result.rows[0] === undefined
        ? undefined
        : decodeOperation(result.rows[0]);
    }, signal);
  }

  public getAttempt(
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<Attempt | undefined> {
    return this.pool.read(
      (client) => this.readAttempt(client, attemptId, signal),
      signal,
    );
  }

  public async readAttempt(
    client: PostgresQueryClient,
    attemptId: string,
    signal?: AbortSignal,
  ): Promise<Attempt | undefined> {
    const result = await client.query<AttemptRow>(
      `SELECT attempt_id, run_id, execution_generation, state,
              cancellation_desired, start_authorization, start_fence,
              start_revocation_revision, allocation_id, dispatch_id,
              execution_id, result_manifest_id, terminalization_intent,
              terminal_release_receipt_id, attachment_rejections,
              reservation_request_revision, version
         FROM ${this.schema}.lifecycle_attempt
        WHERE attempt_id = $1`,
      [attemptId],
      signal,
    );
    return result.rows[0] === undefined
      ? undefined
      : decodeAttempt(result.rows[0]);
  }

  public getCancellation(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<CancellationReceipt | undefined> {
    return this.pool.read(async (client) => {
      const result = await client.query<CancellationRow>(
        `SELECT operation_id, run_id, status
           FROM ${this.schema}.lifecycle_cancellation
          WHERE operation_id = $1`,
        [operationId],
        signal,
      );
      return result.rows[0] === undefined
        ? undefined
        : decodeCancellation(result.rows[0]);
    }, signal);
  }

  public getOperation(
    callerScope: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationStatus | undefined> {
    return this.pool.read(async (client) => {
      const result = await client.query<OperationRow>(
        `SELECT operation_id, kind, status, resource_id
          FROM ${this.schema}.lifecycle_operation
          WHERE operation_id = $1 AND caller_scope = $2`,
        [operationId, callerScope],
        signal,
      );
      return result.rows[0] === undefined
        ? undefined
        : decodeOperation(result.rows[0]);
    }, signal);
  }

  public getRun(runId: string, signal?: AbortSignal): Promise<Run | undefined> {
    return this.pool.read(
      (client) => this.readRun(client, runId, signal),
      signal,
    );
  }

  public async readRun(
    client: PostgresQueryClient,
    runId: string,
    signal?: AbortSignal,
  ): Promise<Run | undefined> {
    const result = await client.query<RunRow>(
      `SELECT run_id, workload_id, attempt_id, cancellation_desired,
              state, terminal_outcome, version
         FROM ${this.schema}.lifecycle_run
        WHERE run_id = $1`,
      [runId],
      signal,
    );
    return result.rows[0] === undefined ? undefined : decodeRun(result.rows[0]);
  }

  public getWorkload(
    workloadId: string,
    signal?: AbortSignal,
  ): Promise<Workload | undefined> {
    return this.pool.read(
      (client) => this.readWorkload(client, workloadId, signal),
      signal,
    );
  }

  public async readWorkload(
    client: PostgresQueryClient,
    workloadId: string,
    signal?: AbortSignal,
  ): Promise<Workload | undefined> {
    const result = await client.query<WorkloadRow>(
      `SELECT workload_id, tenant_id, principal_id, spec, spec_digest
         FROM ${this.schema}.lifecycle_workload
        WHERE workload_id = $1`,
      [workloadId],
      signal,
    );
    return result.rows[0] === undefined
      ? undefined
      : decodeWorkload(result.rows[0]);
  }

  public async getStatus(
    callerScope: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<WorkloadStatus | undefined> {
    return this.pool.read(async (client) => {
      const result = await client.query<StatusRow>(
        `SELECT to_jsonb(attempt) AS attempt,
                to_jsonb(r) AS run,
                to_jsonb(workload) AS workload
           FROM ${this.schema}.lifecycle_run r
           JOIN ${this.schema}.lifecycle_acceptance a ON a.run_id = r.run_id
           JOIN ${this.schema}.lifecycle_attempt attempt
             ON attempt.attempt_id = r.attempt_id
            AND attempt.run_id = r.run_id
           JOIN ${this.schema}.lifecycle_workload workload
             ON workload.workload_id = r.workload_id
          WHERE r.run_id = $1 AND a.caller_scope = $2`,
        [runId, callerScope],
        signal,
      );
      const row = result.rows[0];
      if (row === undefined) return undefined;
      return Object.freeze({
        attempt: decodeAttempt(row.attempt),
        run: decodeRun(row.run),
        workload: decodeWorkload(row.workload),
      });
    }, signal);
  }
}
