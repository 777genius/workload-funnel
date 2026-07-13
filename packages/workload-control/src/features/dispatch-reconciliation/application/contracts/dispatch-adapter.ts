import type { MutationFence } from "@workload-funnel/kernel";

export interface DispatchMutationAuthority {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly clusterIncarnation: string;
  readonly clusterIncarnationVersion: number;
  readonly desiredEffect: "dispatch_submit" | "dispatch_cancel";
  readonly effectScopeKey: string;
  readonly executionGeneration: string;
  readonly expectedDesiredVersion: number;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly openGates: ReadonlySet<string>;
  readonly operationGateRevision: number;
  readonly ownerFence: number;
  readonly requiredGate: string;
  readonly startFence?: string;
  readonly startRevocationRevision?: number;
  readonly supersessionKey: string;
}

export interface DispatchSubmissionInput {
  readonly authority: DispatchMutationAuthority;
  readonly dispatchId: string;
  readonly executionGeneration: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
}

export interface DispatchCancellationInput {
  readonly authority: DispatchMutationAuthority;
  readonly dispatchId: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
}

export interface DispatchSubmissionEvidence {
  readonly adapterReference: string;
  readonly fingerprint: string;
}

export interface DispatchSubmitter {
  submit(input: DispatchSubmissionInput): DispatchSubmissionEvidence;
}

export interface DispatchCanceler {
  cancel(input: DispatchCancellationInput): void;
}

export interface DispatchObserver {
  observe(dispatchId: string): "accepted" | "canceled" | "absent";
}

export interface DispatchCapabilityProvider {
  readonly adapter: "dispatcher-local";
  readonly adapterContractVersion: 1;
  readonly capabilities: readonly ["local_dispatch"];
}

export type ExternalDispatchCapability =
  | "custom_resource_placement"
  | "durable_observation"
  | "encrypted_transport"
  | "hard_process_ownership"
  | "lookup_by_operation_id"
  | "mutation_fencing"
  | "never_restart"
  | "process_tree_cancellation"
  | "remote_multi_node"
  | "submit_idempotency"
  | "tenant_isolation";

export interface ExternalDispatchCapabilities {
  readonly adapterContractVersion: number;
  readonly adapterKey: string;
  readonly available: readonly ExternalDispatchCapability[];
  readonly limitations: readonly ExternalDispatchLimitation[];
  readonly productionEnabled: boolean;
  readonly refusalReasons: readonly string[];
}

export type ExternalDispatchLimitation =
  | "adapter_schema_unstable"
  | "global_priority_starvation_risk"
  | "journal_recovery_limited"
  | "logical_resources_not_hard_isolation"
  | "multi_tenant_security_unproven"
  | "no_scheduler_tenant_fairness"
  | "platform_support_limited"
  | "submit_outcome_not_idempotent"
  | "transport_security_unproven"
  | "upstream_recovery_risk_unresolved"
  | "worker_loss_restart_policy_unproven";

export type EffectReceiptOutcome =
  | "applied"
  | "already_applied"
  | "rejected"
  | "superseded"
  | "unknown";

export interface EffectReceiptEvidence {
  readonly authorityId: string;
  readonly authorityRegistrySequence: number;
  readonly comparisonFields: Readonly<Record<string, string | number | null>>;
  readonly comparisonResult: string;
  readonly effectKind: "dispatch_submit" | "dispatch_cancel";
  readonly effectScopeKey: string;
  readonly externalMappingOrInvocationId?: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly outcome: EffectReceiptOutcome;
  readonly reason: string;
}

export type ExternalDispatchMutationReceipt =
  | {
      readonly disposition: "accepted";
      readonly evidence: EffectReceiptEvidence & {
        readonly outcome: "applied";
      };
    }
  | {
      readonly disposition: "already_applied";
      readonly evidence: EffectReceiptEvidence & {
        readonly outcome: "already_applied";
      };
    }
  | {
      readonly disposition: "rejected";
      readonly evidence: EffectReceiptEvidence & {
        readonly outcome: "rejected";
      };
    }
  | {
      readonly disposition: "superseded";
      readonly evidence: EffectReceiptEvidence & {
        readonly outcome: "superseded";
      };
    }
  | {
      readonly disposition: "unknown";
      readonly evidence: EffectReceiptEvidence & {
        readonly outcome: "unknown";
      };
    };

export function toExternalDispatchMutationReceipt(
  evidence: EffectReceiptEvidence,
): ExternalDispatchMutationReceipt {
  switch (evidence.outcome) {
    case "applied":
      return {
        disposition: "accepted",
        evidence: Object.freeze({ ...evidence, outcome: "applied" as const }),
      };
    case "already_applied":
      return {
        disposition: "already_applied",
        evidence: Object.freeze({
          ...evidence,
          outcome: "already_applied" as const,
        }),
      };
    case "rejected":
      return {
        disposition: "rejected",
        evidence: Object.freeze({ ...evidence, outcome: "rejected" as const }),
      };
    case "superseded":
      return {
        disposition: "superseded",
        evidence: Object.freeze({
          ...evidence,
          outcome: "superseded" as const,
        }),
      };
    case "unknown":
      return {
        disposition: "unknown",
        evidence: Object.freeze({ ...evidence, outcome: "unknown" as const }),
      };
  }
}
