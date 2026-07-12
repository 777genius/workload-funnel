import type {
  AcceptanceReceipt,
  CancellationReceipt,
  OperationStatus,
  SubmitCommand,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

export interface WorkloadApiPort {
  submit(command: SubmitCommand): AcceptanceReceipt;
  status(runId: string): WorkloadStatus | undefined;
  cancel(runId: string, idempotencyKey: string): CancellationReceipt;
  operationStatus(operationId: string): OperationStatus | undefined;
}

export interface WorkloadApi {
  submit(
    command: SubmitCommand,
  ): Readonly<{ status: 202; body: AcceptanceReceipt }>;
  status(runId: string): Readonly<{ status: 200 | 404; body?: WorkloadStatus }>;
  cancel(
    runId: string,
    idempotencyKey: string,
  ): Readonly<{ status: 202; body: CancellationReceipt }>;
  operationStatus(
    operationId: string,
  ): Readonly<{ status: 200 | 404; body?: OperationStatus }>;
}

export function createWorkloadApi(port: WorkloadApiPort): WorkloadApi {
  const api: WorkloadApi = {
    cancel(runId, idempotencyKey) {
      return Object.freeze({
        body: port.cancel(runId, idempotencyKey),
        status: 202,
      });
    },
    operationStatus(operationId) {
      const body = port.operationStatus(operationId);
      return body === undefined
        ? Object.freeze({ status: 404 })
        : Object.freeze({ body, status: 200 });
    },
    status(runId) {
      const body = port.status(runId);
      return body === undefined
        ? Object.freeze({ status: 404 })
        : Object.freeze({ body, status: 200 });
    },
    submit(command) {
      return Object.freeze({ body: port.submit(command), status: 202 });
    },
  };
  return Object.freeze(api);
}
