import type { MutationFence } from "@workload-funnel/kernel";
import type {
  PreparedTargetTicket,
  TargetCanonicalAuthorityGrant,
  TargetMutationBoundary,
  TargetMutationKind,
  TargetOperationState,
} from "@workload-funnel/node-execution/process-lifecycle";

export const RUNTIME_BROKER_CONTRACT_VERSION =
  "subscription-runtime.broker.v1" as const;

export interface RuntimeBrokerCapabilitiesV1 {
  readonly contractVersion: string;
  readonly cursorSnapshots: boolean;
  readonly durableOperationReceipts: boolean;
  readonly foregroundOwnedExecution: boolean;
  readonly mutationKinds: readonly TargetMutationKind[];
  readonly mutationBoundaries: readonly TargetMutationBoundary[];
  readonly runtimeBuildSha: string;
  readonly runtimeMutationFencing: boolean;
  readonly targetId: string;
}

export interface RuntimeMutationRequestV1 {
  readonly boundary: TargetMutationBoundary;
  readonly causationId: string;
  readonly contractVersion: typeof RUNTIME_BROKER_CONTRACT_VERSION;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly intentFingerprint: string;
  readonly kind: TargetMutationKind;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly payloadDigest?: string;
  readonly requestId: string;
  readonly ticket: PreparedTargetTicket;
}

export interface RuntimeOperationReceiptV1 {
  readonly contractVersion: string;
  readonly intentFingerprint: string;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly rejectionCode?: string;
  readonly runtimeBuildSha: string;
  readonly runtimeOperationId: string;
  readonly state: TargetOperationState;
}

export interface RuntimeAuthorityCloseRequestV1 {
  readonly changeId: string;
  readonly contractVersion: typeof RUNTIME_BROKER_CONTRACT_VERSION;
  readonly effectScopeKey: string;
  readonly targetId: string;
}

export interface RuntimeAuthorityCloseAckV1 {
  readonly changeId: string;
  readonly effectScopeKey: string;
  readonly registryRevision: number;
  readonly targetId: string;
}

export interface RuntimeAuthorityInstallRequestV1 {
  readonly closeAcknowledgement: RuntimeAuthorityCloseAckV1;
  readonly contractVersion: typeof RUNTIME_BROKER_CONTRACT_VERSION;
  readonly grant: TargetCanonicalAuthorityGrant;
}

export interface RuntimeAuthorityInstallAckV1 {
  readonly authorityGrantId: string;
  readonly changeId: string;
  readonly effectScopeKey: string;
  readonly mutationFenceFingerprint: string;
  readonly registryRevision: number;
  readonly targetId: string;
}

export interface RuntimeFinalMutatorV1<
  Boundary extends TargetMutationBoundary,
> {
  mutate(
    request: RuntimeMutationRequestV1 & { readonly boundary: Boundary },
  ): Promise<RuntimeOperationReceiptV1>;
}

export interface RuntimeFinalMutatorSetV1 {
  readonly provider: RuntimeFinalMutatorV1<"provider">;
  readonly runtime: RuntimeFinalMutatorV1<"runtime">;
  readonly session: RuntimeFinalMutatorV1<"session">;
}

export interface RuntimeBrokerClientV1 {
  closeMutationScope(
    request: RuntimeAuthorityCloseRequestV1,
  ): Promise<RuntimeAuthorityCloseAckV1>;
  discoverCapabilities(targetId: string): Promise<RuntimeBrokerCapabilitiesV1>;
  findOperation(
    targetId: string,
    idempotencyKey: string,
  ): Promise<RuntimeOperationReceiptV1 | undefined>;
  readonly finalMutators: RuntimeFinalMutatorSetV1;
  installMutationAuthority(
    request: RuntimeAuthorityInstallRequestV1,
  ): Promise<RuntimeAuthorityInstallAckV1>;
  reopenMutationScope(
    acknowledgement: RuntimeAuthorityInstallAckV1,
  ): Promise<void>;
}
