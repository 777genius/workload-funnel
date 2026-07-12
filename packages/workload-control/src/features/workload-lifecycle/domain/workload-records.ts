export type TerminalOutcome = "succeeded" | "failed" | "canceled";
export type AttemptTerminalDisposition =
  | TerminalOutcome
  | "publication_failure"
  | "lost";
export type AttemptState =
  | "queued"
  | "admitted"
  | "dispatching"
  | "starting"
  | "running"
  | "publishing_results"
  | "unknown"
  | "reconciliation_required"
  | "lost"
  | TerminalOutcome;

export type CancellationDesired = "none" | "requested";

export interface TerminalizationIntent {
  readonly terminalizationIntentId: string;
  readonly executionGeneration: string;
  readonly allocationId?: string;
  readonly disposition: AttemptTerminalDisposition;
  readonly evidenceKind: string;
  readonly evidenceVersion: number;
  readonly evidenceDigest: string;
  readonly precedenceDecision: "completion_won" | "cancellation_won";
  readonly creatingOperationId: string;
}

export interface ResourceRequest {
  readonly cpuMillis: number;
  readonly memoryMiB: number;
}

export interface SyntheticResultFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkloadSpec {
  readonly schemaVersion: 1;
  readonly processProfile: "trusted-synthetic-v1";
  readonly command: readonly string[];
  readonly resources: ResourceRequest;
  readonly syntheticOutcome: TerminalOutcome;
  readonly resultFiles: readonly SyntheticResultFile[];
}

export interface Workload {
  readonly workloadId: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly spec: WorkloadSpec;
  readonly specDigest: string;
}

export interface Run {
  readonly runId: string;
  readonly workloadId: string;
  readonly attemptId: string;
  readonly cancellationDesired: CancellationDesired;
  readonly state: "accepted" | "active" | TerminalOutcome;
  readonly terminalOutcome?: TerminalOutcome;
  readonly version: number;
}

export interface Attempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly executionGeneration: string;
  readonly state: AttemptState;
  readonly cancellationDesired: CancellationDesired;
  readonly startAuthorization: "authorized" | "revoked";
  readonly startFence: string;
  readonly startRevocationRevision: number;
  readonly allocationId?: string;
  readonly dispatchId?: string;
  readonly executionId?: string;
  readonly resultManifestId?: string;
  readonly terminalizationIntent?: TerminalizationIntent;
  readonly terminalReleaseReceiptId?: string;
  readonly attachmentRejections: number;
  readonly reservationRequestRevision: number;
  readonly version: number;
}

export interface AcceptanceReceipt {
  readonly operationId: string;
  readonly workloadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly duplicate: boolean;
}

export interface CancellationReceipt {
  readonly operationId: string;
  readonly runId: string;
  readonly status: "cancellation_requested" | "already_terminal";
}

export interface OperationStatus {
  readonly operationId: string;
  readonly kind: "submit" | "cancel";
  readonly status: "committed";
  readonly resourceId: string;
}

export interface WorkloadStatus {
  readonly workload: Workload;
  readonly run: Run;
  readonly attempt: Attempt;
}

export class InvalidWorkloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidWorkloadError";
  }
}
