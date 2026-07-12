import type { AllocationService } from "@workload-funnel/workload-control/allocation-leasing";
import type { LocalDispatcher } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { DeterministicExecutor } from "@workload-funnel/workload-control/execution-reconciliation";
import {
  assertGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type {
  WorkloadLifecycleService,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type {
  CancellationSaga,
  CancellationSagaStore,
} from "../domain/cancellation-saga.js";

export interface CancellationProcessManager {
  quiesce(operationId: string, status: WorkloadStatus): CancellationSaga;
  complete(operationId: string, status: WorkloadStatus): CancellationSaga;
}

export function createCancellationProcessManager(
  store: CancellationSagaStore,
  lifecycle: WorkloadLifecycleService,
  allocations: AllocationService,
  dispatcher: LocalDispatcher,
  executor: DeterministicExecutor,
  gates: () => OperationGateSet,
): CancellationProcessManager {
  const manager: CancellationProcessManager = {
    quiesce(operationId, status) {
      const prior = store.get(operationId);
      if (prior?.state === "completed") return prior;
      assertGateOpen(gates(), "cancel");
      const revokedAttempt = Object.freeze({
        ...status.attempt,
        cancellationDesired: "requested" as const,
        startAuthorization: "revoked" as const,
        version: status.attempt.version + 1,
      });
      lifecycle.applyAttempt(revokedAttempt);
      if (revokedAttempt.allocationId !== undefined)
        dispatcher.cancel(revokedAttempt.allocationId);
      if (revokedAttempt.dispatchId !== undefined)
        executor.stop(revokedAttempt.dispatchId);
      if (revokedAttempt.allocationId !== undefined)
        allocations.release(revokedAttempt.allocationId);
      const quiesced: CancellationSaga = Object.freeze({
        attemptId: status.attempt.attemptId,
        operationId,
        runId: status.run.runId,
        state: "execution_stopped",
        version: (prior?.version ?? 0) + 1,
      });
      store.save(quiesced);
      return quiesced;
    },
    complete(operationId, status) {
      const prior = store.get(operationId);
      if (prior?.state === "completed") return prior;
      if (prior?.state !== "execution_stopped") {
        throw new Error("Cancellation cannot complete before quiescence");
      }
      lifecycle.applyAttempt(
        Object.freeze({
          ...status.attempt,
          state: "canceled" as const,
          version: status.attempt.version + 1,
        }),
      );
      lifecycle.applyRun(
        Object.freeze({
          ...status.run,
          cancellationDesired: "requested" as const,
          state: "canceled" as const,
          terminalOutcome: "canceled" as const,
          version: status.run.version + 1,
        }),
      );
      const completed: CancellationSaga = Object.freeze({
        attemptId: status.attempt.attemptId,
        operationId,
        runId: status.run.runId,
        state: "completed",
        version: prior.version + 1,
      });
      store.save(completed);
      return completed;
    },
  };
  return Object.freeze(manager);
}
