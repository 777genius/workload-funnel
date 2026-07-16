import {
  validateWorkloadSpec,
  type AcceptanceReceipt,
  type Attempt,
  type AttemptState,
  type CancellationReceipt,
  type OperationStatus,
  type Run,
  type TerminalizationIntent,
  type Workload,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { PostgresLifecycleError } from "./postgres-errors.js";

export interface AcceptanceRow extends Record<string, unknown> {
  readonly attempt_id: string;
  readonly execution_generation: string;
  readonly operation_id: string;
  readonly run_id: string;
  readonly spec_digest: string;
  readonly workload_id: string;
}

export interface AttemptRow extends Record<string, unknown> {
  readonly allocation_id: string | null;
  readonly attachment_rejections: number;
  readonly attempt_id: string;
  readonly cancellation_desired: string;
  readonly dispatch_id: string | null;
  readonly execution_generation: string;
  readonly execution_id: string | null;
  readonly reservation_request_revision: number;
  readonly result_manifest_id: string | null;
  readonly run_id: string;
  readonly start_authorization: string;
  readonly start_fence: string;
  readonly start_revocation_revision: number;
  readonly state: string;
  readonly terminal_release_receipt_id: string | null;
  readonly terminalization_intent: unknown;
  readonly version: number;
}

export interface CancellationRow extends Record<string, unknown> {
  readonly operation_id: string;
  readonly run_id: string;
  readonly status: string;
}

export interface OperationRow extends Record<string, unknown> {
  readonly kind: string;
  readonly operation_id: string;
  readonly resource_id: string;
  readonly status: string;
}

export interface RunRow extends Record<string, unknown> {
  readonly attempt_id: string;
  readonly cancellation_desired: string;
  readonly run_id: string;
  readonly state: string;
  readonly terminal_outcome: string | null;
  readonly version: number;
  readonly workload_id: string;
}

export interface WorkloadRow extends Record<string, unknown> {
  readonly principal_id: string;
  readonly spec: unknown;
  readonly spec_digest: string;
  readonly tenant_id: string;
  readonly workload_id: string;
}

function corrupt(): never {
  throw new PostgresLifecycleError("postgres_lifecycle_row_corrupt");
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) corrupt();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value);
}

function nonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    corrupt();
  return value;
}

function positiveInteger(value: unknown): number {
  const result = nonnegativeInteger(value);
  if (result === 0) corrupt();
  return result;
}

const attemptStates = new Set<AttemptState>([
  "admitted",
  "canceled",
  "dispatching",
  "failed",
  "lost",
  "publishing_results",
  "queued",
  "reconciliation_required",
  "running",
  "starting",
  "succeeded",
  "unknown",
]);

function terminalizationIntent(
  value: unknown,
): TerminalizationIntent | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) corrupt();
  const row = value as Record<string, unknown>;
  const disposition = requiredString(row["disposition"]);
  const precedenceDecision = requiredString(row["precedenceDecision"]);
  if (
    ![
      "canceled",
      "failed",
      "lost",
      "publication_failure",
      "succeeded",
    ].includes(disposition) ||
    !["cancellation_won", "completion_won"].includes(precedenceDecision)
  )
    corrupt();
  const allocationId = optionalString(row["allocationId"]);
  return Object.freeze({
    ...(allocationId === undefined ? {} : { allocationId }),
    creatingOperationId: requiredString(row["creatingOperationId"]),
    disposition: disposition as TerminalizationIntent["disposition"],
    evidenceDigest: requiredString(row["evidenceDigest"]),
    evidenceKind: requiredString(row["evidenceKind"]),
    evidenceVersion: positiveInteger(row["evidenceVersion"]),
    executionGeneration: requiredString(row["executionGeneration"]),
    precedenceDecision:
      precedenceDecision as TerminalizationIntent["precedenceDecision"],
    terminalizationIntentId: requiredString(row["terminalizationIntentId"]),
  });
}

export function decodeAcceptance(row: AcceptanceRow): AcceptanceReceipt {
  return Object.freeze({
    attemptId: requiredString(row.attempt_id),
    duplicate: false,
    executionGeneration: requiredString(row.execution_generation),
    operationId: requiredString(row.operation_id),
    runId: requiredString(row.run_id),
    workloadId: requiredString(row.workload_id),
  });
}

export function decodeAttempt(row: AttemptRow): Attempt {
  if (
    !attemptStates.has(row.state as AttemptState) ||
    !["none", "requested"].includes(row.cancellation_desired) ||
    !["authorized", "revoked"].includes(row.start_authorization)
  )
    corrupt();
  const allocationId = optionalString(row.allocation_id);
  const dispatchId = optionalString(row.dispatch_id);
  const executionId = optionalString(row.execution_id);
  const resultManifestId = optionalString(row.result_manifest_id);
  const terminalReleaseReceiptId = optionalString(
    row.terminal_release_receipt_id,
  );
  const intent = terminalizationIntent(row.terminalization_intent);
  return Object.freeze({
    ...(allocationId === undefined ? {} : { allocationId }),
    attachmentRejections: nonnegativeInteger(row.attachment_rejections),
    attemptId: requiredString(row.attempt_id),
    cancellationDesired:
      row.cancellation_desired as Attempt["cancellationDesired"],
    ...(dispatchId === undefined ? {} : { dispatchId }),
    executionGeneration: requiredString(row.execution_generation),
    ...(executionId === undefined ? {} : { executionId }),
    reservationRequestRevision: nonnegativeInteger(
      row.reservation_request_revision,
    ),
    runId: requiredString(row.run_id),
    ...(resultManifestId === undefined ? {} : { resultManifestId }),
    startAuthorization:
      row.start_authorization as Attempt["startAuthorization"],
    startFence: requiredString(row.start_fence),
    startRevocationRevision: nonnegativeInteger(row.start_revocation_revision),
    state: row.state as AttemptState,
    ...(terminalReleaseReceiptId === undefined
      ? {}
      : { terminalReleaseReceiptId }),
    ...(intent === undefined ? {} : { terminalizationIntent: intent }),
    version: positiveInteger(row.version),
  });
}

export function decodeCancellation(row: CancellationRow): CancellationReceipt {
  if (!["already_terminal", "cancellation_requested"].includes(row.status))
    corrupt();
  return Object.freeze({
    operationId: requiredString(row.operation_id),
    runId: requiredString(row.run_id),
    status: row.status as CancellationReceipt["status"],
  });
}

export function decodeOperation(row: OperationRow): OperationStatus {
  if (!["cancel", "submit"].includes(row.kind) || row.status !== "committed")
    corrupt();
  return Object.freeze({
    kind: row.kind as OperationStatus["kind"],
    operationId: requiredString(row.operation_id),
    resourceId: requiredString(row.resource_id),
    status: "committed",
  });
}

export function decodeRun(row: RunRow): Run {
  if (
    !["none", "requested"].includes(row.cancellation_desired) ||
    !["accepted", "active", "succeeded", "failed", "canceled"].includes(
      row.state,
    ) ||
    (row.terminal_outcome !== null &&
      !["succeeded", "failed", "canceled"].includes(row.terminal_outcome))
  )
    corrupt();
  const terminalOutcome = optionalString(row.terminal_outcome);
  const run: Run = {
    attemptId: requiredString(row.attempt_id),
    cancellationDesired: row.cancellation_desired as Run["cancellationDesired"],
    runId: requiredString(row.run_id),
    state: row.state as Run["state"],
    version: positiveInteger(row.version),
    workloadId: requiredString(row.workload_id),
  };
  return Object.freeze(
    terminalOutcome === undefined
      ? run
      : {
          ...run,
          terminalOutcome: terminalOutcome as NonNullable<
            Run["terminalOutcome"]
          >,
        },
  );
}

export function decodeWorkload(row: WorkloadRow): Workload {
  return Object.freeze({
    principalId: requiredString(row.principal_id),
    spec: validateWorkloadSpec(row.spec),
    specDigest: requiredString(row.spec_digest),
    tenantId: requiredString(row.tenant_id),
    workloadId: requiredString(row.workload_id),
  });
}
