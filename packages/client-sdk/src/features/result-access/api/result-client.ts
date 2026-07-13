import type { ResultManifest } from "@workload-funnel/workload-control/result-management";

export interface ResultTransport {
  request<T>(
    input: Readonly<{
      method: "GET" | "POST";
      path: string;
      query?: Readonly<Record<string, string>>;
      body?: unknown;
    }>,
  ): Promise<T>;
}

export interface ResultMutationOptions {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly requestId?: string;
  readonly expectedVersion?: number;
}

export interface AuditedOperationReceiptV1 {
  readonly contractVersion: "workload-funnel.audited-operation/v1";
  readonly operationId: string;
  readonly state:
    | "accepted"
    | "completed"
    | "pending_legal_hold"
    | "reconciliation_required";
  readonly auditId: string;
  readonly duplicate: boolean;
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

function mutation(tenantId: string, options: ResultMutationOptions): unknown {
  return Object.freeze({
    causationId: options.causationId ?? options.correlationId,
    contractVersion: "workload-funnel.mutation/v1",
    correlationId: options.correlationId,
    expectedVersion: options.expectedVersion,
    idempotencyKey: options.idempotencyKey,
    requestedTenantScope: tenantId,
    requestId: options.requestId ?? crypto.randomUUID(),
  });
}

export function createResultAccessClient(
  transport: ResultTransport,
  tenantId: string,
): Readonly<{
  result(resultManifestId: string): Promise<
    Readonly<{
      contractVersion: "workload-funnel.result/v1";
      manifest: ResultManifest;
    }>
  >;
  requestRetention(
    resultManifestId: string,
    action: "archive" | "delete",
    reason: string,
    options: ResultMutationOptions,
  ): Promise<AuditedOperationReceiptV1>;
  requestErasure(
    subjectReference: string,
    dataClasses: readonly ErasureDataClass[],
    reason: string,
    options: ResultMutationOptions,
  ): Promise<AuditedOperationReceiptV1>;
}> {
  return Object.freeze({
    requestErasure: (subjectReference, dataClasses, reason, options) =>
      transport.request({
        body: Object.freeze({
          contractVersion: "workload-funnel.erasure-operation/v1",
          dataClasses: Object.freeze([...dataClasses]),
          mutation: mutation(tenantId, options),
          reason,
          subjectReference,
        }),
        method: "POST",
        path: "/v1/erasures",
      }),
    requestRetention: (resultManifestId, action, reason, options) =>
      transport.request({
        body: Object.freeze({
          action,
          contractVersion: "workload-funnel.retention-operation/v1",
          mutation: mutation(tenantId, options),
          reason,
        }),
        method: "POST",
        path: `/v1/results/${encodeURIComponent(resultManifestId)}/retention`,
      }),
    result: (resultManifestId) =>
      transport.request({
        method: "GET",
        path: `/v1/results/${encodeURIComponent(resultManifestId)}`,
        query: Object.freeze({ tenant: tenantId }),
      }),
  });
}
