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
import {
  closeCancellationBarrier,
  createCancellationSaga,
  recordAuthorityEvidence,
  recordCancellationExecutionEvidence,
  recordCancellationRelease,
  recordStartRevocation,
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
      if (
        prior?.state === "completed" ||
        prior?.state === "release_committed"
      ) {
        return prior;
      }
      assertGateOpen(gates(), "cancel");
      const revokedAttempt = Object.freeze({
        ...status.attempt,
        cancellationDesired: "requested" as const,
        startAuthorization: "revoked" as const,
        startRevocationRevision: status.attempt.startRevocationRevision + 1,
        version: status.attempt.version + 1,
      });
      lifecycle.applyAttempt(revokedAttempt);
      if (revokedAttempt.allocationId !== undefined)
        dispatcher.cancel(revokedAttempt.allocationId);
      const stopObservation =
        revokedAttempt.dispatchId === undefined
          ? undefined
          : executor.stop(revokedAttempt.dispatchId);
      let saga = createCancellationSaga(
        operationId,
        status.run.runId,
        status.attempt.attemptId,
      );
      saga = recordStartRevocation(
        saga,
        revokedAttempt.startRevocationRevision,
      );
      saga = recordAuthorityEvidence(saga, {
        authorityId: "deterministic-in-memory-final-authority",
        evidenceDigest: `synthetic-authority:${operationId}:${String(revokedAttempt.startRevocationRevision)}`,
        kind: "acknowledged",
        revision: revokedAttempt.startRevocationRevision,
      });
      saga = recordCancellationExecutionEvidence(saga, {
        evidenceDigest:
          stopObservation === undefined
            ? `synthetic-absence:${operationId}`
            : `synthetic-stop:${stopObservation.executionId}:${String(stopObservation.sequence)}`,
        kind: stopObservation === undefined ? "not_submitted" : "stopped",
      });
      saga = closeCancellationBarrier(saga, [
        "deterministic-in-memory-final-authority",
      ]);
      const releaseReceipt =
        revokedAttempt.allocationId === undefined
          ? `no-allocation:${status.attempt.attemptId}:${operationId}`
          : allocations.release(revokedAttempt.allocationId).proofId;
      saga = recordCancellationRelease(saga, releaseReceipt);
      store.save(saga);
      return saga;
    },
    complete(operationId, status) {
      const prior = store.get(operationId);
      if (prior?.state === "completed") return prior;
      if (prior?.state !== "release_committed") {
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
