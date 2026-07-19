import type { ExternalDispatchCapabilities } from "@workload-funnel/workload-control/dispatch-reconciliation";

export const HYPERQUEUE_RESEARCH_BASELINE = "0.26.2" as const;

export interface HyperQueueProductionGateEvidence {
  readonly ambiguousLiveSubmitCancellationProven: boolean;
  readonly approvedProductionChecksum: string | null;
  readonly approvedProductionVersion: string | null;
  readonly ambiguousSubmitLookupProven: boolean;
  readonly cancellationProcessTreeProven: boolean;
  readonly credentialCustodyProven: boolean;
  readonly durableObservationSequenceProven: boolean;
  readonly fallbackExecutionTested: boolean;
  readonly mappingCreateOnlyProven: boolean;
  readonly neverRestartProven: boolean;
  readonly operationNameContract: string | null;
  readonly productionPolicyProfileApproved: boolean;
  readonly replayClassMappingApproved: boolean;
  readonly securityReviewApproved: boolean;
  readonly upstreamRiskDecisionApproved: boolean;
  readonly unresolvedOperationRetentionProven: boolean;
}

export const CHECKED_HYPERQUEUE_PRODUCTION_GATE: HyperQueueProductionGateEvidence =
  Object.freeze({
    ambiguousLiveSubmitCancellationProven: false,
    approvedProductionChecksum: null,
    approvedProductionVersion: null,
    ambiguousSubmitLookupProven: false,
    cancellationProcessTreeProven: false,
    credentialCustodyProven: false,
    durableObservationSequenceProven: true,
    fallbackExecutionTested: false,
    mappingCreateOnlyProven: false,
    neverRestartProven: false,
    operationNameContract: "workload-funnel.hq-operation-name.v1",
    productionPolicyProfileApproved: false,
    replayClassMappingApproved: false,
    securityReviewApproved: false,
    upstreamRiskDecisionApproved: false,
    unresolvedOperationRetentionProven: false,
  });

export function discoverHyperQueueCapabilities(): ExternalDispatchCapabilities {
  return Object.freeze({
    adapterContractVersion: 1,
    adapterKey: "scheduler-hyperqueue",
    available: Object.freeze([
      "custom_resource_placement",
      "durable_observation",
      "mutation_fencing",
      "remote_multi_node",
    ] as const),
    limitations: Object.freeze([
      "adapter_schema_unstable",
      "global_priority_starvation_risk",
      "journal_recovery_limited",
      "logical_resources_not_hard_isolation",
      "multi_tenant_security_unproven",
      "no_scheduler_tenant_fairness",
      "platform_support_limited",
      "submit_outcome_not_idempotent",
      "transport_security_unproven",
      "upstream_recovery_risk_unresolved",
      "worker_loss_restart_policy_unproven",
    ] as const),
    productionEnabled: false,
    refusalReasons: Object.freeze([
      "production_pin_unapproved",
      "ambiguous_submit_disposable_probe_missing",
      "ambiguous_live_submit_cancellation_unproven",
      "worker_loss_never_restart_unproven",
      "security_review_pending",
      "upstream_risk_decision_pending",
    ]),
  });
}

export function assertHyperQueueProductionEnabled(): never {
  throw new Error("hyperqueue_production_pin_unapproved");
}
