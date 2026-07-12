import { authenticateSyntheticToken } from "@workload-funnel/control-service/authentication";
import type {
  SubmitCommand,
  WorkloadApi,
} from "@workload-funnel/control-service/workload-controller";

export interface SyntheticHttpApi {
  submit(
    token: string,
    command: SubmitCommand,
  ): ReturnType<WorkloadApi["submit"]>;
  status(token: string, runId: string): ReturnType<WorkloadApi["status"]>;
  cancel(
    token: string,
    runId: string,
    idempotencyKey: string,
  ): ReturnType<WorkloadApi["cancel"]>;
  operationStatus(
    token: string,
    operationId: string,
  ): ReturnType<WorkloadApi["operationStatus"]>;
}

export function createSyntheticHttpApi(
  workloads: WorkloadApi,
): SyntheticHttpApi {
  function authenticate(token: string): void {
    authenticateSyntheticToken(token);
  }
  const api: SyntheticHttpApi = {
    cancel(token, runId, idempotencyKey) {
      authenticate(token);
      return workloads.cancel(runId, idempotencyKey);
    },
    operationStatus(token, operationId) {
      authenticate(token);
      return workloads.operationStatus(operationId);
    },
    status(token, runId) {
      authenticate(token);
      return workloads.status(runId);
    },
    submit(token, command) {
      authenticate(token);
      return workloads.submit(command);
    },
  };
  return Object.freeze(api);
}
