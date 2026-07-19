import { describe, expect, it } from "vitest";

import { acceptPostgresLifecycle } from "../acceptance.js";
import {
  PostgresLifecycleError,
  TransactionFailure,
} from "../postgres-errors.js";
import type {
  PostgresPoolRuntime,
  PostgresQueryClient,
  PostgresQueryResult,
} from "../postgres-pool.js";

describe("Postgres acceptance reconciliation", () => {
  it("uses an independent read after an acknowledged COMMIT and caller abort", async () => {
    const controller = new AbortController();
    let mutationCount = 0;
    let reconciliationCount = 0;
    const committedRow = Object.freeze({
      attempt_id: "attempt-0001",
      execution_generation: "generation-0001",
      operation_id: "submit-operation",
      run_id: "run-0001",
      spec_digest: "spec-digest",
      workload_id: "workload-0001",
    });
    const reconciliationClient: PostgresQueryClient = Object.freeze({
      backendProcessId: 2,
      query: <Row extends Record<string, unknown>>(): Promise<
        PostgresQueryResult<Row>
      > =>
        Promise.resolve({
          rowCount: 1,
          rows: [committedRow as unknown as Row],
        }),
    });
    const pool = {
      async reconcile<T>(
        work: (client: PostgresQueryClient) => Promise<T>,
      ): Promise<T> {
        reconciliationCount += 1;
        return work(reconciliationClient);
      },
      transaction(): Promise<never> {
        mutationCount += 1;
        controller.abort();
        return Promise.reject(
          new TransactionFailure(
            new Error("synthetic_failure_after_commit_acknowledgement"),
            true,
            true,
          ),
        );
      },
    } as unknown as PostgresPoolRuntime;

    const receipt = await acceptPostgresLifecycle(
      { pool, schema: "wf_reconciliation_test" },
      {
        callerScope: "caller-scope",
        idempotencyKey: "idempotency-key",
        principalId: "principal",
        spec: Object.freeze({
          command: Object.freeze(["synthetic"]),
          processProfile: "trusted-synthetic-v1",
          resources: Object.freeze({ cpuMillis: 1, memoryMiB: 1 }),
          resultFiles: Object.freeze([]),
          schemaVersion: 1,
          syntheticOutcome: "succeeded",
        }),
        specDigest: committedRow.spec_digest,
        tenantId: "tenant",
      },
      controller.signal,
    );

    expect(receipt).toEqual({
      attemptId: committedRow.attempt_id,
      duplicate: false,
      executionGeneration: committedRow.execution_generation,
      operationId: committedRow.operation_id,
      runId: committedRow.run_id,
      workloadId: committedRow.workload_id,
    });
    expect(controller.signal.aborted).toBe(true);
    expect(mutationCount).toBe(1);
    expect(reconciliationCount).toBe(1);
  });

  it("does not retry a mutation when reconciliation fails after caller cancellation", async () => {
    const controller = new AbortController();
    let mutationCount = 0;
    const pool = {
      reconcile(): Promise<never> {
        return Promise.reject(
          new PostgresLifecycleError("postgres_lifecycle_unavailable"),
        );
      },
      transaction(): Promise<never> {
        mutationCount += 1;
        controller.abort();
        return Promise.reject(
          new TransactionFailure(new Error("ambiguous_commit"), true, false),
        );
      },
    } as unknown as PostgresPoolRuntime;

    await expect(
      acceptPostgresLifecycle(
        { pool, schema: "wf_reconciliation_test" },
        {
          callerScope: "caller-scope",
          idempotencyKey: "idempotency-key",
          principalId: "principal",
          spec: Object.freeze({
            command: Object.freeze(["synthetic"]),
            processProfile: "trusted-synthetic-v1",
            resources: Object.freeze({ cpuMillis: 1, memoryMiB: 1 }),
            resultFiles: Object.freeze([]),
            schemaVersion: 1,
            syntheticOutcome: "succeeded",
          }),
          specDigest: "spec-digest",
          tenantId: "tenant",
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "postgres_lifecycle_outcome_unknown" });
    expect(mutationCount).toBe(1);
  });
});
