import type { ResultManifest } from "@workload-funnel/workload-control/result-management";

export interface ResultRequestContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly authorizationPolicyVersion: number;
}

export interface OperationsMutationEnvelopeV1 {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestedTenantScope: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly expectedVersion?: number;
  readonly requiredExtensions?: readonly string[];
}

export interface ResultViewV1 {
  readonly contractVersion: "workload-funnel.result/v1";
  readonly manifest: ResultManifest;
}

export interface RetentionOperationRequestV1 {
  readonly contractVersion: string;
  readonly mutation: OperationsMutationEnvelopeV1;
  readonly action: "archive" | "delete";
  readonly reason: string;
  readonly requiredExtensions?: readonly string[];
}

export type ErasureDataClass =
  | "workload_specs"
  | "principal_references"
  | "canonical_events"
  | "audit"
  | "idempotency_receipts"
  | "projections"
  | "inbox_outbox_dlq"
  | "logs"
  | "artifacts"
  | "backups";

export interface ErasureOperationRequestV1 {
  readonly contractVersion: string;
  readonly mutation: OperationsMutationEnvelopeV1;
  readonly subjectReference: string;
  readonly dataClasses: readonly ErasureDataClass[];
  readonly reason: string;
  readonly requiredExtensions?: readonly string[];
}

export interface AuditedOperationReceiptV1 {
  readonly contractVersion: "workload-funnel.audited-operation/v1";
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly state:
    | "accepted"
    | "completed"
    | "pending_legal_hold"
    | "reconciliation_required";
  readonly auditId: string;
  readonly duplicate: boolean;
}

export interface AuditViewRecordV1 {
  readonly auditId: string;
  readonly actorId: string;
  readonly action: string;
  readonly reason: string;
  readonly authorizationPolicyVersion: number;
  readonly previousState?: string;
  readonly nextState?: string;
  readonly correlationId: string;
  readonly affectedResources: readonly string[];
  readonly occurredAt: number;
  readonly previousHash: string;
  readonly hash: string;
}

export interface ResultOperationsPort {
  result(
    context: ResultRequestContext,
    resultManifestId: string,
  ): ResultManifest | undefined;
  requestRetention(
    context: ResultRequestContext,
    resultManifestId: string,
    request: RetentionOperationRequestV1,
  ): AuditedOperationReceiptV1;
  requestErasure(
    context: ResultRequestContext,
    request: ErasureOperationRequestV1,
  ): AuditedOperationReceiptV1;
  audit(
    context: ResultRequestContext,
    afterSequence: number,
    limit: number,
  ): readonly AuditViewRecordV1[];
}

export interface ResultOperationsController {
  result(
    context: ResultRequestContext,
    resultManifestId: string,
  ): ResultViewV1 | undefined;
  requestRetention(
    context: ResultRequestContext,
    resultManifestId: string,
    request: RetentionOperationRequestV1,
  ): AuditedOperationReceiptV1;
  requestErasure(
    context: ResultRequestContext,
    request: ErasureOperationRequestV1,
  ): AuditedOperationReceiptV1;
  audit(
    context: ResultRequestContext,
    afterSequence: number,
    limit: number,
  ): readonly AuditViewRecordV1[];
}

const erasureDataClasses = new Set<ErasureDataClass>([
  "workload_specs",
  "principal_references",
  "canonical_events",
  "audit",
  "idempotency_receipts",
  "projections",
  "inbox_outbox_dlq",
  "logs",
  "artifacts",
  "backups",
]);

function bounded(value: unknown, maximum = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}

function validateMutation(
  context: ResultRequestContext,
  mutation: OperationsMutationEnvelopeV1,
): void {
  if (mutation.contractVersion !== "workload-funnel.mutation/v1")
    throw new Error("unsupported_mutation_contract");
  if (
    mutation.requiredExtensions !== undefined &&
    (!Array.isArray(mutation.requiredExtensions) ||
      mutation.requiredExtensions.length > 0)
  )
    throw new Error("unsupported_required_extension");
  if (
    !bounded(mutation.requestId) ||
    !bounded(mutation.idempotencyKey) ||
    !bounded(mutation.requestedTenantScope) ||
    !bounded(mutation.correlationId) ||
    !bounded(mutation.causationId)
  )
    throw new Error("invalid_mutation_envelope");
  if (mutation.requestedTenantScope !== context.effectiveTenantId)
    throw new Error("effective_tenant_mismatch");
  if (
    mutation.expectedVersion !== undefined &&
    (!Number.isSafeInteger(mutation.expectedVersion) ||
      mutation.expectedVersion < 0)
  )
    throw new Error("invalid_expected_version");
}

function rejectClaimedIdentity(value: object): void {
  const identityFields = new Set([
    "actor",
    "actorId",
    "principal",
    "principalId",
    "effectiveTenant",
    "effectiveTenantId",
  ]);
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== "object" || candidate === null) continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      if (identityFields.has(key))
        throw new Error("caller_identity_field_forbidden");
      pending.push(nested);
    }
  }
}

export function createResultOperationsController(
  port: ResultOperationsPort,
): ResultOperationsController {
  const controller: ResultOperationsController = {
    audit(context, afterSequence, limit) {
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new Error("invalid_audit_page");
      return Object.freeze([...port.audit(context, afterSequence, limit)]);
    },
    requestErasure(context, request) {
      rejectClaimedIdentity(request);
      if (
        request.contractVersion !== "workload-funnel.erasure-operation/v1" ||
        !bounded(request.subjectReference) ||
        !bounded(request.reason, 1024) ||
        request.dataClasses.length < 1 ||
        request.dataClasses.length > 10 ||
        new Set(request.dataClasses).size !== request.dataClasses.length ||
        request.dataClasses.some((item) => !erasureDataClasses.has(item))
      )
        throw new Error("invalid_erasure_operation");
      if (
        request.requiredExtensions !== undefined &&
        (!Array.isArray(request.requiredExtensions) ||
          request.requiredExtensions.length > 0)
      )
        throw new Error("unsupported_required_extension");
      validateMutation(context, request.mutation);
      return port.requestErasure(context, request);
    },
    requestRetention(context, resultManifestId, request) {
      rejectClaimedIdentity(request);
      if (
        request.contractVersion !== "workload-funnel.retention-operation/v1" ||
        !["archive", "delete"].includes(request.action) ||
        !bounded(resultManifestId) ||
        !bounded(request.reason, 1024)
      )
        throw new Error("invalid_retention_operation");
      if (
        request.requiredExtensions !== undefined &&
        (!Array.isArray(request.requiredExtensions) ||
          request.requiredExtensions.length > 0)
      )
        throw new Error("unsupported_required_extension");
      validateMutation(context, request.mutation);
      return port.requestRetention(context, resultManifestId, request);
    },
    result(context, resultManifestId) {
      if (!bounded(resultManifestId)) throw new Error("invalid_result_id");
      const manifest = port.result(context, resultManifestId);
      return manifest === undefined
        ? undefined
        : Object.freeze({
            contractVersion: "workload-funnel.result/v1",
            manifest,
          });
    },
  };
  return Object.freeze(controller);
}
