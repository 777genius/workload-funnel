// Synthetic/disposable relational profiles; no external database or process is used.
import {
  createAllocationLeasingTransactionParticipant,
  createAllocationEffectCommand,
  createAllocationService,
  type Allocation,
} from "@workload-funnel/workload-control/allocation-leasing";
import { createAuditHistoryTransactionParticipant } from "@workload-funnel/workload-control/audit-history";
import {
  createCanonicalCoordinator,
  type CanonicalParticipantRegistry,
  type CanonicalTransactionTrace,
  type ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";
import { createPostgresCanonicalTransaction } from "@workload-funnel/store-postgres/canonical-transaction";
import { createPostgresAuditLedgerStore } from "@workload-funnel/store-postgres/audit-ledger-persistence";
import { createPostgresInboxStore } from "@workload-funnel/store-postgres/command-inbox";
import { createPostgresProjectionStore } from "@workload-funnel/store-postgres/projection-checkpoints";
import { createInMemoryPostgresReconciliationClaimStoreTestFake } from "@workload-funnel/store-postgres/reconciliation-claims";
import { createPostgresOutboxStore } from "@workload-funnel/store-postgres/transactional-outbox";
import { createPostgresLifecycleRepository } from "@workload-funnel/store-postgres/workload-persistence";
import { createSqliteCanonicalTransaction } from "@workload-funnel/store-sqlite/canonical-transaction";
import { createSqliteAuditLedgerStore } from "@workload-funnel/store-sqlite/audit-ledger-persistence";
import { createSqliteInboxStore } from "@workload-funnel/store-sqlite/command-inbox";
import { createSqliteProjectionStore } from "@workload-funnel/store-sqlite/projection-checkpoints";
import { createInMemorySqliteReconciliationClaimStoreTestFake } from "@workload-funnel/store-sqlite/reconciliation-claims";
import { createSqliteOutboxStore } from "@workload-funnel/store-sqlite/transactional-outbox";
import { createSqliteLifecycleRepository } from "@workload-funnel/store-sqlite/workload-persistence";
import { createLocalDispatchCapabilityProvider } from "@workload-funnel/dispatcher-local/capability-discovery";
import { createLocalDispatchCanceler } from "@workload-funnel/dispatcher-local/dispatch-cancellation";
import { createLocalDispatchObserver } from "@workload-funnel/dispatcher-local/dispatch-observation";
import { createLocalDispatchSubmitter } from "@workload-funnel/dispatcher-local/dispatch-submission";
import {
  createCancellationProcessManager,
  type CancellationSaga,
} from "@workload-funnel/workload-control/cancellation";
import { createCapacityManagementTransactionParticipant } from "@workload-funnel/workload-control/capacity-management";
import { createControlEventDeliveryTransactionParticipant } from "@workload-funnel/workload-control/control-event-delivery";
import {
  createDispatchSubmissionCommand,
  createLocalDispatcher,
} from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  createDeterministicExecutor,
  createExecutionStartCommand,
} from "@workload-funnel/workload-control/execution-reconciliation";
import { assertGateOpen } from "@workload-funnel/workload-control/operation-gating";
import {
  createOwnershipTransferService,
  type OwnershipTransferService,
} from "@workload-funnel/workload-control/ownership-transfer";
import {
  createResultManagementService,
  createResultManagementTransactionParticipant,
  type ResultManagementService,
} from "@workload-funnel/workload-control/result-management";
import { createTenantAdmissionTransactionParticipant } from "@workload-funnel/workload-control/tenant-admission";
import {
  createWorkloadLifecycleService,
  createWorkloadLifecycleTransactionParticipant,
  type AcceptanceReceipt,
  type Attempt,
  type AuthenticatedPrincipal,
  type CancellationReceipt,
  type OperationStatus,
  type SubmitCommand,
  type WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type {
  SyntheticDatabase,
  SyntheticDatabaseProfile,
} from "./synthetic-state.js";
import {
  capacityLedger,
  dispatchStore,
  executionStore,
  resultStore,
} from "./synthetic-stores.js";
import { ownershipTransferCoordinatorStore } from "./synthetic-ownership-stores.js";
import {
  prepareSyntheticEffectFence,
  prepareSyntheticResultFinalizeCommand,
  publishSyntheticResultFiles,
} from "./synthetic-fence-flow.js";

const principal: AuthenticatedPrincipal = Object.freeze({
  namespaceId: "test://phase1/walking-slice",
  principalId: "synthetic-principal",
  tenantId: "synthetic-tenant",
});

export interface Phase1SyntheticService {
  readonly profile: SyntheticDatabaseProfile;
  readonly participantCount: 7;
  readonly principal: AuthenticatedPrincipal;
  submit(command: SubmitCommand): AcceptanceReceipt;
  status(runId: string): WorkloadStatus | undefined;
  cancel(runId: string, idempotencyKey: string): CancellationReceipt;
  operationStatus(operationId: string): OperationStatus | undefined;
  step(): boolean;
  runUntilIdle(): void;
  rejectNextAttachment(): void;
  failNextAttachmentRejectionAt(
    boundary: "before-commit" | "after-commit",
  ): void;
  redeliver(messageId: string): void;
  reserve(runId: string): Allocation;
  capacity(): {
    readonly reservedCpuMillis: number;
    readonly reservedMemoryMiB: number;
  };
  claimStore: ReconciliationClaimStore;
  ownershipTransfer: OwnershipTransferService;
  dispatchObservation(dispatchId: string): "accepted" | "canceled" | "absent";
  result(
    resultManifestId: string,
  ): ReturnType<ResultManagementService["getById"]>;
  requestRetention(
    input: Parameters<ResultManagementService["requestRetention"]>[0],
  ): ReturnType<ResultManagementService["requestRetention"]>;
  erasePrincipalReferences(input: {
    readonly operationId: string;
    readonly subjectPrincipalId: string;
    readonly pseudonym: string;
  }): number;
}

export function createPhase1SyntheticService(
  database: SyntheticDatabase,
): Phase1SyntheticService {
  const { state } = database;
  const traceSink = {
    append(trace: CanonicalTransactionTrace) {
      state.lockTrace.push(
        ...trace.events.map(
          (event) =>
            `${trace.backend}:${trace.bundleId}:${trace.operationId}:${event}`,
        ),
      );
    },
  };
  const transaction =
    database.profile === "postgres"
      ? createPostgresCanonicalTransaction(traceSink)
      : createSqliteCanonicalTransaction(traceSink);
  const participants: CanonicalParticipantRegistry = Object.freeze({
    "allocation-leasing": createAllocationLeasingTransactionParticipant(),
    "audit-history": createAuditHistoryTransactionParticipant(),
    "capacity-management": createCapacityManagementTransactionParticipant(),
    "control-event-delivery":
      createControlEventDeliveryTransactionParticipant(),
    "result-management": createResultManagementTransactionParticipant(),
    "tenant-admission": createTenantAdmissionTransactionParticipant(),
    "workload-lifecycle": createWorkloadLifecycleTransactionParticipant(),
  });
  const coordinator = createCanonicalCoordinator({
    canonicalTransaction: transaction,
    participants,
  });
  const persistence =
    database.profile === "postgres"
      ? Object.freeze({
          audit: createPostgresAuditLedgerStore(state.audit),
          inbox: createPostgresInboxStore(state.inbox),
          outbox: createPostgresOutboxStore(state.outbox),
          projections: createPostgresProjectionStore(state.projections),
        })
      : Object.freeze({
          audit: createSqliteAuditLedgerStore(state.audit),
          inbox: createSqliteInboxStore(state.inbox),
          outbox: createSqliteOutboxStore(state.outbox),
          projections: createSqliteProjectionStore(state.projections),
        });
  const lifecycleHooks = {
    accepted(input: {
      readonly operationId: string;
      readonly workloadId: string;
      readonly runId: string;
      readonly attemptId: string;
    }) {
      state.queuedCount += 1;
      persistence.outbox.append(
        "attempt-ready",
        input.attemptId,
        `ready:${input.attemptId}:0`,
      );
      persistence.audit.append(
        input.operationId,
        principal.principalId,
        "workload.accepted",
        input.workloadId,
      );
      persistence.projections.project(
        Object.freeze({
          runId: input.runId,
          state: "accepted",
          watermark: 1,
        }),
      );
    },
    cancellationRequested(input: {
      readonly operationId: string;
      readonly runId: string;
      readonly attemptId: string;
    }) {
      persistence.outbox.append(
        "attempt-canceled",
        input.attemptId,
        `cancel:${input.operationId}`,
      );
      persistence.audit.append(
        input.operationId,
        principal.principalId,
        "run.cancellation-requested",
        input.runId,
      );
    },
    projectRun(run: WorkloadStatus["run"]) {
      persistence.projections.project(
        Object.freeze({
          runId: run.runId,
          state: run.state,
          watermark: run.version,
        }),
      );
    },
  };
  const lifecycleRepository =
    database.profile === "postgres"
      ? createPostgresLifecycleRepository({
          hooks: lifecycleHooks,
          state,
        })
      : createSqliteLifecycleRepository({
          hooks: lifecycleHooks,
          state,
        });
  const lifecycle = createWorkloadLifecycleService(
    lifecycleRepository,
    coordinator,
  );
  const allocations = createAllocationService(capacityLedger(state));
  const dispatchCapability = createLocalDispatchCapabilityProvider();
  if (!dispatchCapability.capabilities.includes("local_dispatch")) {
    throw new Error("Local dispatcher capability is unavailable");
  }
  const dispatchObserver = createLocalDispatchObserver(
    state.localDispatchEffects,
  );
  const dispatcher = createLocalDispatcher(
    dispatchStore(state),
    () => state.gateSet,
    createLocalDispatchSubmitter(
      state.localDispatchEffects,
      state.localDispatchHighWatermarks,
    ),
    createLocalDispatchCanceler(
      state.localDispatchEffects,
      state.localDispatchHighWatermarks,
    ),
  );
  const executor = createDeterministicExecutor(
    executionStore(state),
    () => state.gateSet,
  );
  const results = createResultManagementService(
    resultStore(state),
    () => state.gateSet,
  );
  const sagaStore = {
    get: (operationId: string) => state.sagas.get(operationId),
    save: (saga: CancellationSaga) => state.sagas.set(saga.operationId, saga),
  };
  const cancellation = createCancellationProcessManager(
    sagaStore,
    lifecycle,
    allocations,
    dispatcher,
    executor,
    () => state.gateSet,
  );
  const claimState = {
    claims: state.claims,
    nextFence: () => ++state.claimFence,
  };
  const reconciliationClaims =
    database.profile === "postgres"
      ? createInMemoryPostgresReconciliationClaimStoreTestFake(claimState)
      : createInMemorySqliteReconciliationClaimStoreTestFake(claimState);
  const ownershipTransfer = createOwnershipTransferService(
    ownershipTransferCoordinatorStore(state, reconciliationClaims),
    reconciliationClaims,
  );

  function statusForAttempt(attempt: Attempt): WorkloadStatus {
    const run = state.runById.get(attempt.runId);
    if (run === undefined) throw new Error("Run does not exist");
    const status = lifecycle.status(principal, run.runId);
    if (status === undefined) throw new Error("Workload status does not exist");
    return status;
  }

  function stepAttempt(attempt: Attempt): boolean {
    const status = statusForAttempt(attempt);
    if (
      attempt.cancellationDesired === "requested" &&
      attempt.state !== "canceled"
    ) {
      if (attempt.resultManifestId === undefined) {
        coordinator.execute(
          "finalize-result-v1",
          `result:${attempt.attemptId}`,
          () => {
            const finalized = results.finalize(
              prepareSyntheticResultFinalizeCommand(state, attempt, []),
            );
            lifecycle.applyAttempt(
              Object.freeze({
                ...attempt,
                resultManifestId: finalized.resultManifestId,
                version: attempt.version + 1,
              }),
            );
            return finalized;
          },
        );
        return true;
      }
      const operationId =
        state.cancelOperationByRun.get(status.run.runId) ??
        `synthetic-cancel:${status.run.runId}`;
      if (!state.terminalIntentAttempts.has(attempt.attemptId)) {
        coordinator.execute(
          "record-attempt-terminal-intent-v1",
          `cancel-intent:${operationId}`,
          () => state.terminalIntentAttempts.add(attempt.attemptId),
        );
        return true;
      }
      if (!state.terminalReleaseAttempts.has(attempt.attemptId)) {
        coordinator.execute(
          "release-allocation-v1",
          `cancel-release:${operationId}`,
          () => {
            const reservedId = state.allocationByAttempt.get(attempt.attemptId);
            if (
              reservedId !== undefined &&
              attempt.allocationId === undefined
            ) {
              const reserved = state.allocations.get(reservedId);
              if (reserved === undefined)
                throw new Error("Reserved Allocation does not exist");
              allocations.release(
                createAllocationEffectCommand(
                  reservedId,
                  attempt.attemptId,
                  prepareSyntheticEffectFence(
                    state,
                    attempt,
                    "process_stop",
                    "cancel",
                    `process:${attempt.attemptId}`,
                    attempt.version + 1,
                    reserved,
                  ),
                ),
              );
            }
            cancellation.quiesce(operationId, status);
            state.terminalReleaseAttempts.add(attempt.attemptId);
          },
        );
        return true;
      }
      coordinator.execute(
        "apply-attempt-terminal-v2",
        `cancel-terminal:${operationId}`,
        () => cancellation.complete(operationId, status),
      );
      persistence.audit.append(
        `terminal:${attempt.attemptId}`,
        principal.principalId,
        "attempt.canceled",
        attempt.attemptId,
      );
      state.queuedCount = Math.max(0, state.queuedCount - 1);
      return true;
    }
    if (attempt.state === "queued") {
      if (attempt.attachmentRejections > 0)
        assertGateOpen(state.gateSet, "automatic_retry");
      const currentAllocationId = state.allocationByAttempt.get(
        attempt.attemptId,
      );
      const currentAllocation =
        currentAllocationId === undefined
          ? undefined
          : state.allocations.get(currentAllocationId);
      if (
        currentAllocation === undefined ||
        currentAllocation.state === "released"
      ) {
        coordinator.execute(
          "reserve-allocation-v1",
          `reserve:${attempt.attemptId}:${String(attempt.reservationRequestRevision)}`,
          () => allocations.reserve(attempt, status.workload.spec.resources),
        );
        return true;
      }
      const allocation = allocations.reserve(
        attempt,
        status.workload.spec.resources,
      );
      if (state.rejectNextAttachment) {
        if (state.failAttachmentRejection === "before-commit") {
          state.failAttachmentRejection = "none";
          throw new Error("Synthetic crash before attachment rejection commit");
        }
        coordinator.execute(
          "reject-allocation-attachment-v1",
          `reject:${allocation.allocationId}`,
          () => {
            allocations.rejectAttachment(allocation.allocationId);
            const rejected = Object.freeze({
              ...attempt,
              attachmentRejections: attempt.attachmentRejections + 1,
              reservationRequestRevision:
                attempt.reservationRequestRevision + 1,
              version: attempt.version + 1,
            });
            lifecycle.applyAttempt(rejected);
            persistence.outbox.append(
              "attachment-rejected",
              attempt.attemptId,
              `retry:${attempt.attemptId}:${String(rejected.reservationRequestRevision)}`,
            );
            persistence.audit.append(
              `reject:${allocation.allocationId}`,
              principal.principalId,
              "allocation.attachment-rejected",
              attempt.attemptId,
            );
          },
        );
        state.rejectNextAttachment = false;
        if (state.failAttachmentRejection === "after-commit") {
          state.failAttachmentRejection = "none";
          throw new Error("Synthetic crash after attachment rejection commit");
        }
        return true;
      }
      coordinator.execute(
        "attach-allocation-v1",
        `attach:${allocation.allocationId}`,
        () => {
          lifecycle.applyAttempt(
            Object.freeze({
              ...attempt,
              allocationId: allocation.allocationId,
              state: "admitted",
              version: attempt.version + 1,
            }),
          );
        },
      );
      return true;
    }
    if (attempt.state === "admitted" && attempt.allocationId !== undefined) {
      const dispatchId = `dispatch-${attempt.allocationId.slice("allocation-".length)}`;
      const mutationFence = prepareSyntheticEffectFence(
        state,
        attempt,
        "dispatch_submit",
        "dispatch_submit",
        `dispatch:${dispatchId}`,
        1,
      );
      const allocation = allocations.activate(
        createAllocationEffectCommand(
          attempt.allocationId,
          attempt.attemptId,
          mutationFence,
        ),
      );
      const receipt = dispatcher.submit(
        createDispatchSubmissionCommand(
          allocation,
          mutationFence,
          attempt.startAuthorization === "authorized",
        ),
      );
      lifecycle.applyAttempt(
        Object.freeze({
          ...attempt,
          dispatchId: receipt.dispatchId,
          state: "dispatching",
          version: attempt.version + 1,
        }),
      );
      return true;
    }
    if (
      attempt.state === "dispatching" &&
      attempt.allocationId !== undefined &&
      attempt.dispatchId !== undefined
    ) {
      const allocation = state.allocations.get(attempt.allocationId);
      const dispatch = state.dispatches.get(attempt.dispatchId);
      if (allocation === undefined || dispatch === undefined)
        throw new Error("Process-manager attachment missing");
      const execution = executor.start(
        createExecutionStartCommand(
          attempt,
          allocation,
          dispatch,
          prepareSyntheticEffectFence(
            state,
            attempt,
            "process_start",
            "process_start",
            `process:${attempt.attemptId}`,
            1,
          ),
        ),
      );
      lifecycle.applyAttempt(
        Object.freeze({
          ...attempt,
          executionId: execution.executionId,
          state: "running",
          version: attempt.version + 1,
        }),
      );
      return true;
    }
    if (attempt.state === "running" && attempt.dispatchId !== undefined) {
      executor.observeTerminal(
        attempt.dispatchId,
        status.workload.spec.syntheticOutcome,
      );
      lifecycle.applyAttempt(
        Object.freeze({
          ...attempt,
          state: "publishing_results",
          version: attempt.version + 1,
        }),
      );
      return true;
    }
    if (attempt.state === "publishing_results") {
      if (attempt.resultManifestId === undefined) {
        coordinator.execute(
          "finalize-result-v1",
          `result:${attempt.attemptId}`,
          () => {
            const manifest = results.finalize(
              prepareSyntheticResultFinalizeCommand(
                state,
                attempt,
                publishSyntheticResultFiles(
                  state,
                  database.artifacts,
                  attempt.attemptId,
                  status.workload.spec.resultFiles,
                ),
              ),
            );
            lifecycle.applyAttempt(
              Object.freeze({
                ...attempt,
                resultManifestId: manifest.resultManifestId,
                version: attempt.version + 1,
              }),
            );
            return manifest;
          },
        );
        return true;
      }
      const manifest = state.manifests.get(attempt.resultManifestId);
      if (manifest === undefined)
        throw new Error("Attached ResultManifest does not exist");
      if (!manifest.complete)
        throw new Error("Terminalization requires a complete manifest");
      if (!state.terminalIntentAttempts.has(attempt.attemptId)) {
        coordinator.execute(
          "record-attempt-terminal-intent-v1",
          `intent:${attempt.attemptId}`,
          () => state.terminalIntentAttempts.add(attempt.attemptId),
        );
        return true;
      }
      if (!state.terminalReleaseAttempts.has(attempt.attemptId)) {
        coordinator.execute(
          "release-allocation-v1",
          `release:${attempt.attemptId}`,
          () => {
            if (attempt.allocationId === undefined)
              throw new Error("Terminal Attempt is missing its Allocation");
            allocations.release(
              createAllocationEffectCommand(
                attempt.allocationId,
                attempt.attemptId,
                prepareSyntheticEffectFence(
                  state,
                  attempt,
                  "artifact_finalize",
                  "result_finalize",
                  `result-finalize:${attempt.attemptId}`,
                  attempt.version + 1,
                ),
              ),
            );
            state.terminalReleaseAttempts.add(attempt.attemptId);
          },
        );
        return true;
      }
      const outcome = status.workload.spec.syntheticOutcome;
      coordinator.execute(
        "apply-attempt-terminal-v2",
        `terminal:${attempt.attemptId}`,
        () => {
          lifecycle.applyAttempt(
            Object.freeze({
              ...attempt,
              state: outcome,
              version: attempt.version + 1,
            }),
          );
          lifecycle.applyRun(
            Object.freeze({
              ...status.run,
              state: outcome,
              terminalOutcome: outcome,
              version: status.run.version + 1,
            }),
          );
        },
      );
      state.queuedCount = Math.max(0, state.queuedCount - 1);
      persistence.audit.append(
        `terminal:${attempt.attemptId}`,
        principal.principalId,
        `attempt.${outcome}`,
        attempt.attemptId,
      );
      return true;
    }
    return false;
  }

  function consumePendingMessage(): boolean {
    const message = persistence.outbox.pending()[0];
    if (message === undefined) return false;
    persistence.inbox.complete("phase1-process-manager", message.messageId);
    persistence.outbox.markDelivered(message.messageId);
    return true;
  }

  const service: Phase1SyntheticService = {
    capacity: () =>
      Object.freeze({
        reservedCpuMillis: state.reservedCpuMillis,
        reservedMemoryMiB: state.reservedMemoryMiB,
      }),
    cancel(runId, idempotencyKey) {
      assertGateOpen(state.gateSet, "cancel");
      return lifecycle.cancel(principal, runId, idempotencyKey);
    },
    claimStore: reconciliationClaims,
    dispatchObservation: (dispatchId) => dispatchObserver.observe(dispatchId),
    erasePrincipalReferences: (input) =>
      lifecycle.erasePrincipalReferences(principal, input),
    operationStatus: (operationId) =>
      lifecycle.operationStatus(principal, operationId),
    ownershipTransfer,
    failNextAttachmentRejectionAt(boundary) {
      state.failAttachmentRejection = boundary;
    },
    participantCount: 7 as const,
    principal,
    profile: database.profile,
    rejectNextAttachment: () => {
      state.rejectNextAttachment = true;
    },
    redeliver(messageId) {
      persistence.outbox.redeliver(messageId);
    },
    requestRetention: (input) => results.requestRetention(input),
    result: (resultManifestId) => results.getById(resultManifestId),
    reserve(runId) {
      const status = lifecycle.status(principal, runId);
      if (status === undefined) throw new Error("Run does not exist");
      return allocations.reserve(
        status.attempt,
        status.workload.spec.resources,
      );
    },
    runUntilIdle() {
      let iterations = 0;
      while (this.step()) {
        iterations += 1;
        if (iterations > 1000)
          throw new Error("Synthetic process manager did not converge");
      }
    },
    status: (runId) => lifecycle.status(principal, runId),
    step() {
      const consumedMessage = consumePendingMessage();
      for (const attempt of state.attemptById.values()) {
        if (stepAttempt(attempt)) return true;
      }
      return consumedMessage;
    },
    submit(command) {
      assertGateOpen(state.gateSet, "accept");
      return lifecycle.submit(principal, command);
    },
  };
  return Object.freeze(service);
}
