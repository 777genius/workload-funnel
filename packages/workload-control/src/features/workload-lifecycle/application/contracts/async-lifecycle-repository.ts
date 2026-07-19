import type {
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  Workload,
  WorkloadStatus,
} from "../../domain/workload-records.js";
import type { AcceptanceInput } from "./lifecycle-repository.js";

export interface AsyncLifecycleCallOptions {
  readonly signal?: AbortSignal;
}

export interface AsyncLifecycleRepository {
  accept(
    input: AcceptanceInput,
    options?: AsyncLifecycleCallOptions,
  ): Promise<AcceptanceReceipt>;
  cancel(
    callerScope: string,
    runId: string,
    operationId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<CancellationReceipt>;
  findOperation(
    callerScope: string,
    idempotencyKey: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<OperationStatus | undefined>;
  getAttempt(
    attemptId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<Attempt | undefined>;
  getCancellation(
    operationId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<CancellationReceipt | undefined>;
  getOperation(
    callerScope: string,
    operationId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<OperationStatus | undefined>;
  getRun(
    runId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<Run | undefined>;
  getStatus(
    callerScope: string,
    runId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<WorkloadStatus | undefined>;
  getWorkload(
    workloadId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<Workload | undefined>;
  saveAttempt(
    attempt: Attempt,
    expectedVersion: number,
    options?: AsyncLifecycleCallOptions,
  ): Promise<void>;
  saveRun(
    run: Run,
    expectedVersion: number,
    options?: AsyncLifecycleCallOptions,
  ): Promise<void>;
  erasePrincipalReferences(
    input: {
      readonly operationId: string;
      readonly tenantId: string;
      readonly subjectPrincipalId: string;
      readonly pseudonym: string;
    },
    options?: AsyncLifecycleCallOptions,
  ): Promise<number>;
}
