import { SCHEDULER_SHIM_PROTOCOL } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import type {
  DispatchEvidence,
  EffectReceiptEvidence,
} from "@workload-funnel/workload-control/dispatch-reconciliation";

export interface HyperQueueReconciliationInput {
  readonly mappingPresent: boolean;
  readonly observations: readonly DispatchEvidence[];
  readonly shimProtocol: typeof SCHEDULER_SHIM_PROTOCOL;
  readonly submitReceipt: EffectReceiptEvidence;
}

export interface HyperQueueReconciliationDecision {
  readonly disposition:
    | "accepted"
    | "running"
    | "terminal"
    | "reconciliation_required";
  readonly reason: string;
  readonly resubmit: false;
}

export function reconcileHyperQueueDispatch(
  input: HyperQueueReconciliationInput,
): HyperQueueReconciliationDecision {
  const shimProtocol: unknown = input.shimProtocol;
  if (shimProtocol !== SCHEDULER_SHIM_PROTOCOL)
    return Object.freeze({
      disposition: "reconciliation_required",
      reason: "scheduler_shim_contract_mismatch",
      resubmit: false,
    });
  if (!input.mappingPresent)
    return Object.freeze({
      disposition: "reconciliation_required",
      reason:
        input.submitReceipt.outcome === "unknown"
          ? "ambiguous_submit_lookup_by_operation_unsupported"
          : "dispatch_mapping_absent",
      resubmit: false,
    });
  const positions = new Map<string, DispatchEvidence>();
  for (const observation of input.observations) {
    const key = `${observation.source}:${String(observation.sourceEpoch)}:${String(observation.sourceSequence)}`;
    const prior = positions.get(key);
    if (prior !== undefined && prior.digest !== observation.digest)
      return Object.freeze({
        disposition: "reconciliation_required",
        reason: "conflicting_scheduler_evidence",
        resubmit: false,
      });
    positions.set(key, observation);
  }
  const current = [...positions.values()]
    .filter((item) => item.complete)
    .sort((left, right) => {
      if (left.sourceEpoch !== right.sourceEpoch)
        return right.sourceEpoch - left.sourceEpoch;
      return right.sourceSequence - left.sourceSequence;
    })[0];
  if (current === undefined || current.observed === "reconciliation_required")
    return Object.freeze({
      disposition: "reconciliation_required",
      reason: "worker_loss_or_observation_ambiguous",
      resubmit: false,
    });
  if (
    current.observed !== "accepted" &&
    current.observed !== "running" &&
    current.observed !== "terminal"
  )
    return Object.freeze({
      disposition: "reconciliation_required",
      reason: "unsupported_scheduler_observation",
      resubmit: false,
    });
  return Object.freeze({
    disposition: current.observed,
    reason: "ordered_mapping_observation",
    resubmit: false,
  });
}

export function createProvider() {
  return Object.freeze({ reconcile: reconcileHyperQueueDispatch });
}
