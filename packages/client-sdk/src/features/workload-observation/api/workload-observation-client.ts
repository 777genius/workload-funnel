import type {
  OperationStatus,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

export interface ObservationTransport {
  request<T>(
    input: Readonly<{
      method: "GET";
      path: string;
      query: Readonly<Record<string, string>>;
    }>,
  ): Promise<T>;
}

export interface WorkloadObservationClient {
  workload(runId: string): Promise<WorkloadStatus>;
  operation(operationId: string): Promise<OperationStatus>;
  explanation(runId: string): Promise<AdmissionExplanationV1>;
}

export interface AdmissionExplanationV1 {
  readonly attemptId: string;
  readonly outcome: "admit" | "defer" | "reject";
  readonly reason: string;
  readonly details: readonly string[];
  readonly admissionPolicyRevision: number;
  readonly fairnessRevision: number;
  readonly evaluatedAt: number;
}

export function createWorkloadObservationClient(
  transport: ObservationTransport,
  tenantId: string,
): WorkloadObservationClient {
  const query = Object.freeze({ tenant: tenantId });
  const client: WorkloadObservationClient = {
    explanation: (runId) =>
      transport.request<AdmissionExplanationV1>({
        method: "GET",
        path: `/v1/workloads/${encodeURIComponent(runId)}/explanation`,
        query,
      }),
    operation: (operationId) =>
      transport.request<OperationStatus>({
        method: "GET",
        path: `/v1/operations/${encodeURIComponent(operationId)}`,
        query,
      }),
    workload: (runId) =>
      transport.request<WorkloadStatus>({
        method: "GET",
        path: `/v1/workloads/${encodeURIComponent(runId)}`,
        query,
      }),
  };
  return Object.freeze(client);
}
