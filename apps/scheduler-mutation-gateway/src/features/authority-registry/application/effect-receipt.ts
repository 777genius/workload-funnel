import {
  validateMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  mutationFenceComparisonFields,
  type EffectReceiptEvidence,
  type MutateHyperQueueRequest,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export function createEffectReceipt(
  request: MutateHyperQueueRequest,
  outcome: "applied" | "rejected" | "superseded" | "unknown",
  reason: string,
  authorityId: string,
  authorityRegistrySequence: number,
  externalMappingOrInvocationId?: string,
): EffectReceiptEvidence {
  const fence: MutationFence = request.mutationFence;
  validateMutationFence(fence);
  return Object.freeze({
    authorityId,
    authorityRegistrySequence,
    comparisonFields: mutationFenceComparisonFields(fence),
    comparisonResult: reason,
    effectKind: request.scope.effectKind,
    effectScopeKey: fence.effectScopeKey,
    ...(externalMappingOrInvocationId === undefined
      ? {}
      : { externalMappingOrInvocationId }),
    mutationFence: fence,
    mutationFenceFingerprint: request.mutationFenceFingerprint,
    operationId: request.operationId,
    outcome,
    reason,
  });
}
