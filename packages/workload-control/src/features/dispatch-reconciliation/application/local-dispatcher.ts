import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  assertGateOpen,
  assertMutationFenceGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";

import type {
  DispatchMutationAuthority,
  DispatchCanceler,
  DispatchSubmitter,
} from "./contracts/dispatch-adapter.js";
import type { DispatchStore } from "./contracts/dispatch-store.js";
import type { Dispatch, DispatchReceipt } from "../domain/dispatch.js";

export interface DispatchSubmissionCommand {
  readonly allocation: Allocation;
  readonly mutationFence: MutationFence;
  readonly startAuthorized: boolean;
}

export interface LocalDispatcher {
  submit(command: DispatchSubmissionCommand): DispatchReceipt;
  cancel(command: DispatchCancellationCommand): DispatchReceipt | undefined;
  get(allocationId: string): Dispatch | undefined;
}

export interface DispatchCancellationCommand {
  readonly allocationId: string;
  readonly mutationFence: MutationFence;
}

export function createDispatchSubmissionCommand(
  allocation: Allocation,
  mutationFence: MutationFence,
  startAuthorized: boolean,
): DispatchSubmissionCommand {
  validateMutationFence(mutationFence);
  return Object.freeze({ allocation, mutationFence, startAuthorized });
}

export function createSyntheticDispatchSubmissionCommand(
  allocation: Allocation,
  startAuthority: Readonly<{
    authorized: boolean;
    startFence: string;
    startRevocationRevision: number;
  }>,
  gates: OperationGateSet,
): DispatchSubmissionCommand {
  const dispatchId = `dispatch-${allocation.allocationId.slice("allocation-".length)}`;
  return Object.freeze({
    allocation,
    mutationFence: Object.freeze({
      allocationId: allocation.allocationId,
      attemptId: allocation.attemptId,
      clusterIncarnation: "synthetic-phase1-cluster",
      clusterIncarnationVersion: 1,
      desiredEffect: "dispatch_submit",
      effectScopeKey: `dispatch:${dispatchId}`,
      executionGeneration: allocation.executionGeneration,
      expectedDesiredVersion: 1,
      issuedStartRevocationRevision: startAuthority.startRevocationRevision,
      namespaceId: gates.namespaceId,
      namespaceWriterEpoch: 1,
      operationGateRevision: gates.revision,
      ownerFence: allocation.ownerFence,
      requiredGate: "dispatch_submit",
      schemaVersion: 1,
      startFence: startAuthority.startFence,
      supersessionKey: `dispatch:${dispatchId}`,
    }),
    startAuthorized: startAuthority.authorized,
  });
}

function assertDispatchSubmissionFence(
  command: DispatchSubmissionCommand,
  dispatchId: string,
  gates: OperationGateSet,
): void {
  const { allocation, mutationFence } = command;
  validateMutationFence(mutationFence);
  if (
    mutationFence.desiredEffect !== "dispatch_submit" ||
    mutationFence.requiredGate !== "dispatch_submit" ||
    mutationFence.operationGateRevision !== gates.revision ||
    mutationFence.namespaceId !== gates.namespaceId ||
    mutationFence.allocationId !== allocation.allocationId ||
    mutationFence.ownerFence !== allocation.ownerFence ||
    mutationFence.attemptId !== allocation.attemptId ||
    mutationFence.executionGeneration !== allocation.executionGeneration ||
    mutationFence.expectedDesiredVersion !== 1 ||
    mutationFence.effectScopeKey !== `dispatch:${dispatchId}` ||
    mutationFence.supersessionKey !== `dispatch:${dispatchId}`
  ) {
    throw new Error("dispatch_submission_fence_mismatch");
  }
}

function assertDispatchCancellationFence(
  dispatch: Dispatch,
  gates: OperationGateSet,
  mutationFence: MutationFence,
): void {
  assertMutationFenceGateOpen(gates, mutationFence, "cancel");
  if (
    mutationFence.desiredEffect !== "dispatch_cancel" ||
    mutationFence.allocationId !== dispatch.allocationId ||
    mutationFence.attemptId !== dispatch.mutationFence.attemptId ||
    mutationFence.executionGeneration !== dispatch.executionGeneration ||
    mutationFence.ownerFence !== dispatch.mutationFence.ownerFence ||
    mutationFence.effectScopeKey !== `dispatch:${dispatch.dispatchId}` ||
    mutationFence.supersessionKey !== mutationFence.effectScopeKey ||
    mutationFence.expectedDesiredVersion !== dispatch.version + 1
  ) {
    throw new Error("dispatch_cancellation_fence_mismatch");
  }
}

function dispatchAuthority(
  mutationFence: MutationFence,
  gates: OperationGateSet,
): DispatchMutationAuthority {
  if (
    mutationFence.allocationId === undefined ||
    mutationFence.ownerFence === undefined
  ) {
    throw new Error("dispatch_allocation_authority_missing");
  }
  return Object.freeze({
    allocationId: mutationFence.allocationId,
    attemptId: mutationFence.attemptId,
    clusterIncarnation: "synthetic-phase1-cluster",
    clusterIncarnationVersion: 1,
    desiredEffect: mutationFence.desiredEffect as
      | "dispatch_submit"
      | "dispatch_cancel",
    effectScopeKey: mutationFence.effectScopeKey,
    executionGeneration: mutationFence.executionGeneration,
    expectedDesiredVersion: mutationFence.expectedDesiredVersion,
    namespaceId: gates.namespaceId,
    namespaceWriterEpoch: 1,
    openGates: gates.open,
    operationGateRevision: gates.revision,
    ownerFence: mutationFence.ownerFence,
    requiredGate: mutationFence.requiredGate,
    ...(mutationFence.startFence === undefined
      ? {}
      : {
          startFence: mutationFence.startFence,
          startRevocationRevision: mutationFence.issuedStartRevocationRevision,
        }),
    supersessionKey: mutationFence.supersessionKey,
  });
}

export function createLocalDispatcher(
  store: DispatchStore,
  gates: () => OperationGateSet,
  submitter: DispatchSubmitter,
  canceler: DispatchCanceler,
): LocalDispatcher {
  const dispatcher: LocalDispatcher = {
    submit(command) {
      const { allocation, startAuthorized } = command;
      const prior = store.getByAllocation(allocation.allocationId);
      if (prior !== undefined) {
        if (
          fingerprintMutationFence(prior.mutationFence) !==
          fingerprintMutationFence(command.mutationFence)
        ) {
          throw new Error("dispatch_submission_operation_conflict");
        }
        return Object.freeze({
          dispatchId: prior.dispatchId,
          disposition:
            prior.observed === "suppressed" ? "suppressed" : "accepted",
          operationId: prior.operationId,
        });
      }
      assertGateOpen(gates(), "dispatch");
      const dispatchId = `dispatch-${allocation.allocationId.slice("allocation-".length)}`;
      assertDispatchSubmissionFence(command, dispatchId, gates());
      assertMutationFenceGateOpen(
        gates(),
        command.mutationFence,
        "dispatch_submit",
      );
      const operationId = `dispatch-submit:${dispatchId}`;
      const suppressed = !startAuthorized;
      const evidence = suppressed
        ? undefined
        : submitter.submit({
            authority: dispatchAuthority(command.mutationFence, gates()),
            dispatchId,
            executionGeneration: allocation.executionGeneration,
            mutationFence: command.mutationFence,
            operationId,
          });
      const dispatch: Dispatch = Object.freeze({
        adapter: "dispatcher-local",
        allocationId: allocation.allocationId,
        desired: suppressed ? "suppressed" : "submit",
        dispatchId,
        executionGeneration: allocation.executionGeneration,
        mutationFence: command.mutationFence,
        observed: suppressed ? "suppressed" : "accepted",
        operationId,
        version: 1,
      });
      store.create(
        dispatch,
        Object.freeze({
          adapterReference:
            evidence?.adapterReference ?? `local-suppressed://${dispatchId}`,
          dispatchId,
          fingerprint: evidence?.fingerprint ?? `suppressed:${operationId}`,
          operationId,
        }),
      );
      return Object.freeze({
        dispatchId,
        disposition: suppressed ? "suppressed" : "accepted",
        operationId,
      });
    },
    cancel(command) {
      const dispatch = store.getByAllocation(command.allocationId);
      if (dispatch === undefined) return undefined;
      if (dispatch.desired !== "cancel") {
        assertDispatchCancellationFence(
          dispatch,
          gates(),
          command.mutationFence,
        );
        if (dispatch.observed !== "suppressed") {
          canceler.cancel({
            authority: dispatchAuthority(command.mutationFence, gates()),
            dispatchId: dispatch.dispatchId,
            mutationFence: command.mutationFence,
            operationId: `dispatch-cancel:${dispatch.dispatchId}`,
          });
        }
        store.save(
          Object.freeze({
            ...dispatch,
            desired: "cancel",
            mutationFence: command.mutationFence,
            version: dispatch.version + 1,
          }),
        );
      }
      return Object.freeze({
        dispatchId: dispatch.dispatchId,
        disposition: "cancel_requested",
        operationId: `dispatch-cancel:${dispatch.dispatchId}`,
      });
    },
    get: (allocationId) => store.getByAllocation(allocationId),
  };
  return Object.freeze(dispatcher);
}
