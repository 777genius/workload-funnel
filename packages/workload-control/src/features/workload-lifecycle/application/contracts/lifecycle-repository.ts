import type {
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  Workload,
  WorkloadSpec,
  WorkloadStatus,
} from "../../domain/workload-records.js";

export interface AcceptanceInput {
  readonly callerScope: string;
  readonly idempotencyKey: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly spec: WorkloadSpec;
  readonly specDigest: string;
}

export interface LifecycleRepository {
  accept(input: AcceptanceInput): AcceptanceReceipt;
  cancel(
    callerScope: string,
    runId: string,
    operationId: string,
  ): CancellationReceipt;
  getStatus(callerScope: string, runId: string): WorkloadStatus | undefined;
  getOperation(
    callerScope: string,
    operationId: string,
  ): OperationStatus | undefined;
  findOperation(
    callerScope: string,
    idempotencyKey: string,
  ): OperationStatus | undefined;
  saveAttempt(attempt: Attempt): void;
  saveRun(run: Run): void;
  getWorkload(workloadId: string): Workload | undefined;
  erasePrincipalReferences(input: {
    readonly operationId: string;
    readonly tenantId: string;
    readonly subjectPrincipalId: string;
    readonly pseudonym: string;
  }): number;
}

export interface LifecyclePersistenceState {
  sequence: number;
  readonly workloadById: Map<string, Workload>;
  readonly runById: Map<string, Run>;
  readonly attemptById: Map<string, Attempt>;
  readonly acceptanceByKey: Map<string, AcceptanceReceipt>;
  readonly acceptanceDigestByKey: Map<string, string>;
  readonly operationById: Map<string, OperationStatus>;
  readonly callerScopeByOperationId: Map<string, string>;
  readonly callerScopeByRunId: Map<string, string>;
  readonly cancelOperationByRun: Map<string, string>;
  readonly cancellationReceiptByOperation: Map<string, CancellationReceipt>;
  readonly lifecycleErasureByOperation: Map<string, LifecycleErasureRecord>;
}

export interface LifecycleErasureRecord {
  readonly changedCount: number;
  readonly pseudonym: string;
  readonly subjectPrincipalId: string;
  readonly tenantId: string;
}

export interface LifecyclePersistenceHooks {
  accepted(input: {
    readonly operationId: string;
    readonly workloadId: string;
    readonly runId: string;
    readonly attemptId: string;
  }): void;
  cancellationRequested(input: {
    readonly operationId: string;
    readonly runId: string;
    readonly attemptId: string;
  }): void;
  projectRun(run: Run): void;
}

export interface LifecyclePersistenceFactoryInput {
  readonly state: LifecyclePersistenceState;
  readonly hooks: LifecyclePersistenceHooks;
}
