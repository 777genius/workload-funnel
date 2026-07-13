export interface CancellationTransport {
  request<T>(
    input: Readonly<{ method: "POST"; path: string; body: unknown }>,
  ): Promise<T>;
}

export interface CancellationMutationOptions {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly requestId?: string;
  readonly expectedVersion?: number;
}

export interface CancellationReceiptV1 {
  readonly operationId: string;
  readonly runId: string;
  readonly status: "cancellation_requested" | "already_terminal";
}

export interface WorkloadCancellationClient {
  cancel(
    runId: string,
    reason: string,
    options: CancellationMutationOptions,
  ): Promise<CancellationReceiptV1>;
}

export function createWorkloadCancellationClient(
  transport: CancellationTransport,
  tenantId: string,
): WorkloadCancellationClient {
  const client: WorkloadCancellationClient = {
    async cancel(runId, reason, options) {
      const response = await transport.request<{
        contractVersion: string;
        operation: CancellationReceiptV1;
      }>({
        body: Object.freeze({
          contractVersion: "workload-funnel.api/v1",
          mutation: Object.freeze({
            causationId: options.causationId ?? options.correlationId,
            contractVersion: "workload-funnel.mutation/v1",
            correlationId: options.correlationId,
            expectedVersion: options.expectedVersion,
            idempotencyKey: options.idempotencyKey,
            requestedTenantScope: tenantId,
            requestId: options.requestId ?? crypto.randomUUID(),
          }),
          reason,
        }),
        method: "POST",
        path: `/v1/workloads/${encodeURIComponent(runId)}/cancellation`,
      });
      if (response.contractVersion !== "workload-funnel.api/v1")
        throw new Error("invalid_server_contract");
      return response.operation;
    },
  };
  return Object.freeze(client);
}
