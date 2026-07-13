import type { MutationFence } from "@workload-funnel/kernel";
import type { EffectReceiptEvidence } from "@workload-funnel/workload-control/dispatch-reconciliation";

export const SCHEDULER_GATEWAY_PROTOCOL =
  "phase7.scheduler-mutation-gateway.v1" as const;

export type SchedulerMutationEffect = "dispatch_submit" | "dispatch_cancel";

export interface SchedulerMutationScope {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly dispatchId: string;
  readonly effectKind: SchedulerMutationEffect;
  readonly executionGeneration: string;
  readonly namespaceId: string;
  readonly schedulerInstanceId: string;
}

export type SchedulerFenceInstallReason =
  | "allocation_takeover"
  | "attempt_revocation"
  | "cluster_rotation"
  | "desired_effect_supersession"
  | "gate_change"
  | "namespace_transfer";

export interface SchedulerFenceInstallClaims {
  readonly authorityId: string;
  readonly expectedPriorFingerprint: string | null;
  readonly installOperationId: string;
  readonly issuedAtMs: number;
  readonly issuerKeyId: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly notAfterMs: number;
  readonly protocolVersion: typeof SCHEDULER_GATEWAY_PROTOCOL;
  readonly reason: SchedulerFenceInstallReason;
  readonly scope: SchedulerMutationScope;
}

export interface SignedSchedulerFenceInstall {
  readonly claims: SchedulerFenceInstallClaims;
  readonly signatureBase64Url: string;
}

export interface SchedulerFenceInstallAcknowledgementClaims {
  readonly authorityId: string;
  readonly comparisonFields: Readonly<Record<string, string | number | null>>;
  readonly comparisonResult: string;
  readonly drainDisposition: "drained" | "unresolved";
  readonly installOperationId: string;
  readonly installedFingerprint: string;
  readonly invalidatedQueueCount: number;
  readonly protocolVersion: typeof SCHEDULER_GATEWAY_PROTOCOL;
  readonly registrySequence: number;
  readonly result: "installed" | "already_installed" | "rejected";
  readonly scope: SchedulerMutationScope;
}

export interface SignedSchedulerFenceInstallAcknowledgement {
  readonly claims: SchedulerFenceInstallAcknowledgementClaims;
  readonly signatureBase64Url: string;
}

export interface SchedulerScopeCloseRequest {
  readonly authorityId: string;
  readonly closeOperationId: string;
  readonly scope: SchedulerMutationScope;
}

export interface SchedulerScopeCloseAcknowledgement {
  readonly closeOperationId: string;
  readonly disposition: "drained" | "unresolved";
  readonly invalidatedQueueCount: number;
  readonly registrySequence: number;
  readonly scope: SchedulerMutationScope;
}

export interface SchedulerScopeReopenRequest {
  readonly acknowledgement: SignedSchedulerFenceInstallAcknowledgement;
  readonly reopenOperationId: string;
}

export interface HyperQueueSubmitMutation {
  readonly dispatchId: string;
  readonly jobName: string;
  readonly kind: "submit";
  readonly mappingFingerprint: string;
  readonly requestedCpuCount: number;
  readonly requiredCustomResources: Readonly<Record<string, number>>;
  readonly restartPolicy: "never";
  readonly shimInvocationBase64: string;
}

export interface HyperQueueCancelMutation {
  readonly dispatchId: string;
  readonly jobId: string;
  readonly kind: "cancel";
  readonly mappingFingerprint: string;
  readonly taskId: string;
}

export type HyperQueueMutation =
  | HyperQueueSubmitMutation
  | HyperQueueCancelMutation;

export interface MutateHyperQueueRequest {
  readonly acknowledgedInstall: SignedSchedulerFenceInstallAcknowledgement;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly payload: HyperQueueMutation;
  readonly protocolVersion: typeof SCHEDULER_GATEWAY_PROTOCOL;
  readonly scope: SchedulerMutationScope;
  readonly submitRevocationAcknowledgement?: SignedSchedulerFenceInstallAcknowledgement;
}

export const authorizedMutationBrand: unique symbol = Symbol(
  "workload-funnel.authorized-hyperqueue-mutation",
);

export interface AuthorizedHyperQueueMutation {
  readonly [authorizedMutationBrand]: true;
  readonly request: MutateHyperQueueRequest;
  readonly registrySequence: number;
}

export interface SchedulerMutationGatewayClient {
  closeAndDrain(
    request: SchedulerScopeCloseRequest,
  ): Promise<SchedulerScopeCloseAcknowledgement>;
  install(
    request: SignedSchedulerFenceInstall,
  ): Promise<SignedSchedulerFenceInstallAcknowledgement>;
  mutate(request: MutateHyperQueueRequest): Promise<EffectReceiptEvidence>;
  reopen(request: SchedulerScopeReopenRequest): Promise<void>;
}

export class GatewayContractError extends Error {
  public constructor(
    public readonly code:
      | "authority_not_installed"
      | "equal_version_mismatch"
      | "gateway_cordoned"
      | "gateway_scope_closed"
      | "install_signature_invalid"
      | "invalid_gateway_request"
      | "lower_authority"
      | "operation_conflict"
      | "prior_fingerprint_mismatch"
      | "release_not_verified",
    detail?: string,
  ) {
    super(detail === undefined ? code : `${code}:${detail}`);
    this.name = "GatewayContractError";
  }
}
