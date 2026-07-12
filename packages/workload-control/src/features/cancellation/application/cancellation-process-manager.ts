import type { AllocationService } from "@workload-funnel/workload-control/allocation-leasing";
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { LocalDispatcher } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { DeterministicExecutor } from "@workload-funnel/workload-control/execution-reconciliation";
import {
  assertMutationFenceGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type {
  WorkloadLifecycleService,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";
import { prepareSyntheticMutationFence } from "@workload-funnel/workload-control/workload-lifecycle";

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

export interface CancellationMutationCommand {
  readonly dispatchCancellationFence?: MutationFence;
  readonly operationId: string;
  readonly processStopFence: MutationFence;
  readonly status: WorkloadStatus;
}

export function createCancellationProcessManager(
  store: CancellationSagaStore,
  lifecycle: WorkloadLifecycleService,
  allocations: AllocationService,
  dispatcher: LocalDispatcher,
  executor: DeterministicExecutor,
  gates: () => OperationGateSet,
): CancellationProcessManager {
  function prepareCommand(
    operationId: string,
    status: WorkloadStatus,
  ): CancellationMutationCommand {
    const gateSet = gates();
    const allocation = allocations.getByAttempt(status.attempt.attemptId);
    const dispatch =
      status.attempt.allocationId === undefined
        ? undefined
        : dispatcher.get(status.attempt.allocationId);
    const authority =
      allocation === undefined
        ? {}
        : {
            allocation: {
              allocationId: allocation.allocationId,
              ownerFence: allocation.ownerFence,
            },
          };
    const processStopFence: MutationFence = prepareSyntheticMutationFence({
      ...authority,
      attempt: status.attempt,
      desiredEffect: "process_stop",
      effectScopeKey: `process:${status.attempt.attemptId}`,
      expectedDesiredVersion: status.attempt.version + 1,
      gateRevision: gateSet.revision,
      namespaceId: gateSet.namespaceId,
      requiredGate: "cancel",
      supersessionKey: `process:${status.attempt.attemptId}`,
    });
    const dispatchCancellationFence: MutationFence | undefined =
      dispatch === undefined
        ? undefined
        : prepareSyntheticMutationFence({
            ...authority,
            attempt: status.attempt,
            desiredEffect: "dispatch_cancel",
            effectScopeKey: `dispatch:${dispatch.dispatchId}`,
            expectedDesiredVersion: dispatch.version + 1,
            gateRevision: gateSet.revision,
            namespaceId: gateSet.namespaceId,
            requiredGate: "cancel",
            supersessionKey: `dispatch:${dispatch.dispatchId}`,
          });
    validateMutationFence(processStopFence);
    if (dispatchCancellationFence !== undefined) {
      validateMutationFence(dispatchCancellationFence);
    }
    return Object.freeze({
      ...(dispatchCancellationFence === undefined
        ? {}
        : { dispatchCancellationFence }),
      operationId,
      processStopFence,
      status,
    });
  }

  const manager: CancellationProcessManager = {
    quiesce(operationId, status) {
      const command = prepareCommand(operationId, status);
      const prior = store.get(operationId);
      if (
        prior?.state === "completed" ||
        prior?.state === "release_committed"
      ) {
        return prior;
      }
      assertMutationFenceGateOpen(gates(), command.processStopFence, "cancel");
      const revokedAttempt = Object.freeze({
        ...status.attempt,
        cancellationDesired: "requested" as const,
        startAuthorization: "revoked" as const,
        startRevocationRevision: status.attempt.startRevocationRevision + 1,
        version: status.attempt.version + 1,
      });
      lifecycle.applyAttempt(revokedAttempt);
      if (
        revokedAttempt.allocationId !== undefined &&
        command.dispatchCancellationFence !== undefined
      ) {
        dispatcher.cancel({
          allocationId: revokedAttempt.allocationId,
          mutationFence: command.dispatchCancellationFence,
        });
      }
      const stopObservation =
        revokedAttempt.dispatchId === undefined
          ? undefined
          : executor.stop({
              dispatchId: revokedAttempt.dispatchId,
              mutationFence: command.processStopFence,
            });
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
          : allocations.release({
              allocationId: revokedAttempt.allocationId,
              attemptId: revokedAttempt.attemptId,
              mutationFence: command.processStopFence,
            }).proofId;
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
