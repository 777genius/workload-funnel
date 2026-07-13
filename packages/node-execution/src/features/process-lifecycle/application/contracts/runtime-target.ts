import type { MutationFence } from "@workload-funnel/kernel";

export const RUNTIME_TARGET_CONTRACT_VERSION =
  "workload-funnel.runtime-target.v1" as const;

export type TargetMutationKind =
  | "create"
  | "start"
  | "resume"
  | "input"
  | "update"
  | "checkpoint"
  | "stop"
  | "cancel"
  | "delete";

export type TargetMutationBoundary = "runtime" | "provider" | "session";

export interface TargetCapabilitySet {
  readonly contractVersion: typeof RUNTIME_TARGET_CONTRACT_VERSION;
  readonly cursorSnapshots: boolean;
  readonly durableOperationReceipts: boolean;
  readonly foregroundOwnedExecution: boolean;
  readonly mutationKinds: readonly TargetMutationKind[];
  readonly mutationBoundaries: readonly TargetMutationBoundary[];
  readonly runtimeBuildSha: string;
  readonly runtimeMutationFencing: boolean;
  readonly targetId: string;
}

export type TargetCapabilityDiscovery =
  | {
      readonly capabilities: TargetCapabilitySet;
      readonly status: "capable";
    }
  | {
      readonly capabilities: TargetCapabilitySet;
      readonly reason:
        | "required_fencing_unsupported"
        | "durable_receipts_unsupported"
        | "cursor_snapshot_unsupported"
        | "foreground_ownership_unsupported"
        | "contract_version_unsupported"
        | "mutation_kind_unsupported"
        | "mutation_boundary_unsupported";
      readonly status: "incapable";
    };

export interface TargetCapabilityProvider {
  discover(
    targetId: string,
    requiredMutationKind?: TargetMutationKind,
    requiredMutationBoundary?: TargetMutationBoundary,
  ): Promise<TargetCapabilityDiscovery>;
}

export interface TargetExecutionTicket {
  readonly causationId: string;
  readonly correlationId: string;
  readonly expiresAtMs: number;
  readonly idempotencyKey: string;
  readonly issuedAtMs: number;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly runtimeTargetId: string;
  readonly sandboxProfileDigest: string;
  readonly ticketId: string;
}

export interface PreparedTargetTicket extends TargetExecutionTicket {
  readonly executionMode: "foreground";
  readonly schemaVersion: "subscription-runtime.execution-ticket.v1";
}

export interface TargetTicketPreparer {
  prepare(ticket: TargetExecutionTicket): PreparedTargetTicket;
}

export interface TargetOperationIntent {
  readonly boundary: TargetMutationBoundary;
  readonly kind: TargetMutationKind;
  readonly payloadDigest?: string;
  readonly ticket: PreparedTargetTicket;
}

export type TargetOperationState =
  | "accepted"
  | "running"
  | "completed"
  | "rejected"
  | "unknown";

export interface TargetOperationReceipt {
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly rejectionCode?:
    | "required_fencing_unsupported"
    | "durable_receipts_unsupported"
    | "cursor_snapshot_unsupported"
    | "foreground_ownership_unsupported"
    | "contract_version_unsupported"
    | "mutation_kind_unsupported"
    | "mutation_boundary_unsupported"
    | "idempotency_conflict"
    | "authority_rejected";
  readonly runtimeBuildSha?: string;
  readonly runtimeOperationId?: string;
  readonly state: TargetOperationState;
}

export interface TargetAuthorityCloseRequest {
  readonly changeId: string;
  readonly effectScopeKey: string;
  readonly targetId: string;
}

export interface TargetAuthorityCloseAcknowledgement {
  readonly changeId: string;
  readonly effectScopeKey: string;
  readonly registryRevision: number;
  readonly targetId: string;
}

export interface TargetAuthorityInstallRequest {
  readonly closeAcknowledgement: TargetAuthorityCloseAcknowledgement;
  readonly grant: TargetCanonicalAuthorityGrant;
}

export interface TargetCanonicalAuthorityGrant {
  readonly audience: string;
  readonly changeId: string;
  readonly expiresAtMs: number;
  readonly grantId: string;
  readonly issuedAtMs: number;
  readonly issuerId: string;
  readonly keyId: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly expectedPriorFingerprint?: string;
  readonly schemaVersion: "workload-funnel.runtime-authority-grant.v1";
  readonly signature: string;
  readonly targetId: string;
}

export interface TargetAuthorityInstallAcknowledgement {
  readonly authorityGrantId: string;
  readonly changeId: string;
  readonly effectScopeKey: string;
  readonly mutationFenceFingerprint: string;
  readonly registryRevision: number;
  readonly targetId: string;
}

export interface TargetOperationDispatcher {
  closeAuthority(
    request: TargetAuthorityCloseRequest,
  ): Promise<TargetAuthorityCloseAcknowledgement>;
  dispatch(intent: TargetOperationIntent): Promise<TargetOperationReceipt>;
  installAuthority(
    request: TargetAuthorityInstallRequest,
  ): Promise<TargetAuthorityInstallAcknowledgement>;
  reopenAuthority(
    acknowledgement: TargetAuthorityInstallAcknowledgement,
  ): Promise<void>;
}

export type TargetObservedState =
  | "accepted"
  | "starting"
  | "running"
  | "exited"
  | "stopped"
  | "unknown"
  | "quarantined";

export interface TargetOperationObservation {
  readonly causationId: string;
  readonly controllerId: string;
  readonly cursor: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly runtimeBuildSha: string;
  readonly runtimeOperationId: string;
  readonly sourceRevision: number;
  readonly state: TargetObservedState;
  readonly targetId: string;
  readonly quarantineReason?: string;
  readonly terminal?: TargetTerminalInput;
}

export interface TargetEventPage {
  readonly events: readonly TargetOperationObservation[];
  readonly nextCursor?: string;
}

export interface TargetSnapshotPage {
  readonly entries: readonly TargetOperationObservation[];
  readonly nextPageToken?: string;
}

export interface TargetEventSource {
  readEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<TargetEventPage>;
  readSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<TargetSnapshotPage>;
}

export interface TargetReconciliationResult {
  readonly checkpoint?: string;
  readonly conflicts: readonly string[];
  readonly observations: readonly TargetOperationObservation[];
}

export interface TargetReconciler {
  reconcile(): Promise<TargetReconciliationResult>;
}

export interface TargetProviderCapacityInput {
  readonly availableSlots?: number;
  readonly observedAtMs: number;
  readonly reason?: string;
  readonly retryAfterMs?: number;
  readonly state:
    | "available"
    | "quota_exhausted"
    | "rate_limited"
    | "unavailable";
}

export interface TargetCapacityObservation {
  readonly availableSlots: number;
  readonly classification:
    | "available"
    | "temporarily_exhausted"
    | "provider_unavailable";
  readonly observedAtMs: number;
  readonly retryAfterMs?: number;
}

export type TargetTerminalInput =
  | {
      readonly completedAtMs: number;
      readonly exitCode: 0;
      readonly outcome: "succeeded";
      readonly resultDigest: string;
    }
  | {
      readonly completedAtMs: number;
      readonly exitCode?: number;
      readonly failureCode: string;
      readonly outcome: "failed";
    }
  | {
      readonly cancellationCode: string;
      readonly completedAtMs: number;
      readonly outcome: "canceled";
    };

export type TargetTerminalObservation =
  | {
      readonly classification: "succeeded";
      readonly completedAtMs: number;
      readonly exitCode: 0;
      readonly resultDigest: string;
    }
  | {
      readonly classification: "provider_failure";
      readonly completedAtMs: number;
      readonly exitCode?: number;
      readonly failureCode: string;
    }
  | {
      readonly cancellationCode: string;
      readonly classification: "canceled";
      readonly completedAtMs: number;
    }
  | {
      readonly classification: "quarantined";
      readonly reason: string;
    };

export interface TargetResultTranslator {
  translateCapacity(
    input: TargetProviderCapacityInput,
  ): TargetCapacityObservation;
  translateTerminal(input: TargetTerminalInput): TargetTerminalObservation;
}
