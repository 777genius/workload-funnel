import type { MutationFence } from "@workload-funnel/kernel";

import type {
  PreparedTargetTicket,
  TargetAuthorityCloseAcknowledgement,
  TargetAuthorityCloseRequest,
  TargetAuthorityInstallAcknowledgement,
  TargetAuthorityInstallRequest,
  TargetCapabilityDiscovery,
  TargetCapabilityProvider,
  TargetCapacityObservation,
  TargetEventPage,
  TargetEventSource,
  TargetExecutionTicket,
  TargetMutationBoundary,
  TargetMutationKind,
  TargetOperationDispatcher,
  TargetOperationIntent,
  TargetOperationReceipt,
  TargetProviderCapacityInput,
  TargetReconciler,
  TargetReconciliationResult,
  TargetResultTranslator,
  TargetSnapshotPage,
  TargetTerminalInput,
  TargetTerminalObservation,
  TargetTicketPreparer,
} from "./contracts/runtime-target.js";

export interface RuntimeTargetSetDependencies {
  readonly capabilityProvider: TargetCapabilityProvider;
  readonly eventSource: TargetEventSource;
  readonly operationDispatcher: TargetOperationDispatcher;
  readonly reconciler: TargetReconciler;
  readonly resultTranslator: TargetResultTranslator;
  readonly ticketPreparer: TargetTicketPreparer;
}

export interface FeatureApi {
  closeRuntimeAuthority(
    request: TargetAuthorityCloseRequest,
  ): Promise<TargetAuthorityCloseAcknowledgement>;
  discoverTarget(
    targetId: string,
    mutationKind?: TargetMutationKind,
    mutationBoundary?: TargetMutationBoundary,
  ): Promise<TargetCapabilityDiscovery>;
  dispatch(intent: TargetOperationIntent): Promise<TargetOperationReceipt>;
  installRuntimeAuthority(
    request: TargetAuthorityInstallRequest,
  ): Promise<TargetAuthorityInstallAcknowledgement>;
  prepareTicket(ticket: TargetExecutionTicket): PreparedTargetTicket;
  readRuntimeEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<TargetEventPage>;
  readRuntimeSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<TargetSnapshotPage>;
  reconcileRuntime(): Promise<TargetReconciliationResult>;
  reopenRuntimeAuthority(
    acknowledgement: TargetAuthorityInstallAcknowledgement,
  ): Promise<void>;
  translateCapacity(
    input: TargetProviderCapacityInput,
  ): TargetCapacityObservation;
  translateTerminal(input: TargetTerminalInput): TargetTerminalObservation;
}

export function createRuntimeTargetSet(
  dependencies: RuntimeTargetSetDependencies,
): FeatureApi {
  return Object.freeze({
    closeRuntimeAuthority(request: TargetAuthorityCloseRequest) {
      return dependencies.operationDispatcher.closeAuthority(request);
    },
    discoverTarget(
      targetId: string,
      mutationKind?: TargetMutationKind,
      mutationBoundary?: TargetMutationBoundary,
    ) {
      return dependencies.capabilityProvider.discover(
        targetId,
        mutationKind,
        mutationBoundary,
      );
    },
    dispatch(intent: TargetOperationIntent) {
      return dependencies.operationDispatcher.dispatch(intent);
    },
    installRuntimeAuthority(request: TargetAuthorityInstallRequest) {
      const mutationFence: MutationFence = request.grant.mutationFence;
      if (
        mutationFence.effectScopeKey !==
        request.closeAcknowledgement.effectScopeKey
      ) {
        throw new Error("runtime_authority_scope_mismatch");
      }
      return dependencies.operationDispatcher.installAuthority(request);
    },
    prepareTicket(ticket: TargetExecutionTicket) {
      const mutationFence: MutationFence = ticket.mutationFence;
      if (mutationFence.attemptId.length === 0) {
        throw new Error("runtime_ticket_attempt_missing");
      }
      return dependencies.ticketPreparer.prepare(ticket);
    },
    readRuntimeEvents(cursor: string | undefined, limit: number) {
      return dependencies.eventSource.readEvents(cursor, limit);
    },
    readRuntimeSnapshot(pageToken: string | undefined, limit: number) {
      return dependencies.eventSource.readSnapshot(pageToken, limit);
    },
    reconcileRuntime() {
      return dependencies.reconciler.reconcile();
    },
    reopenRuntimeAuthority(
      acknowledgement: TargetAuthorityInstallAcknowledgement,
    ) {
      return dependencies.operationDispatcher.reopenAuthority(acknowledgement);
    },
    translateCapacity(input: TargetProviderCapacityInput) {
      return dependencies.resultTranslator.translateCapacity(input);
    },
    translateTerminal(input: TargetTerminalInput) {
      return dependencies.resultTranslator.translateTerminal(input);
    },
  });
}
