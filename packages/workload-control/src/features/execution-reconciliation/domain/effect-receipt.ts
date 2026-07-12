import {
  fingerprintMutationFence,
  type FenceComparisonResult,
  type MutationFence,
} from "./mutation-fence.js";

export type EffectOutcome =
  | "applied"
  | "already_applied"
  | "rejected"
  | "superseded"
  | "unknown";

export interface EffectReceiptEvidence {
  readonly operationId: string;
  readonly effectScopeKey: string;
  readonly effectKind: MutationFence["desiredEffect"];
  readonly outcome: EffectOutcome;
  readonly comparisonResult: FenceComparisonResult;
  readonly mutationFenceFingerprint: string;
  readonly comparisonFields: Readonly<Record<string, string | number | null>>;
  readonly authorityId: string;
  readonly authorityRegistrySequence: number;
  readonly externalMappingOrInvocationId?: string;
}

export function comparisonFieldsForFence(
  fence: MutationFence,
): Readonly<Record<string, string | number | null>> {
  return Object.freeze({
    allocationId: fence.allocationId ?? null,
    attemptId: fence.attemptId,
    clusterIncarnation: fence.clusterIncarnation,
    clusterIncarnationVersion: fence.clusterIncarnationVersion,
    desiredEffect: fence.desiredEffect,
    effectScopeKey: fence.effectScopeKey,
    executionGeneration: fence.executionGeneration,
    expectedDesiredVersion: fence.expectedDesiredVersion,
    issuedStartRevocationRevision: fence.issuedStartRevocationRevision ?? null,
    namespaceWriterEpoch: fence.namespaceWriterEpoch,
    nodeBootEpoch: fence.nodeBootEpoch ?? null,
    operationGateRevision: fence.operationGateRevision,
    ownerFence: fence.ownerFence ?? null,
    requiredGate: fence.requiredGate,
    startFence: fence.startFence ?? null,
    supersessionKey: fence.supersessionKey,
  });
}

export function createEffectReceipt(
  input: Readonly<{
    operationId: string;
    fence: MutationFence;
    outcome: EffectOutcome;
    comparisonResult: FenceComparisonResult;
    authorityId: string;
    authorityRegistrySequence: number;
    externalMappingOrInvocationId?: string;
  }>,
): EffectReceiptEvidence {
  return Object.freeze({
    authorityId: input.authorityId,
    authorityRegistrySequence: input.authorityRegistrySequence,
    comparisonFields: comparisonFieldsForFence(input.fence),
    comparisonResult: input.comparisonResult,
    effectKind: input.fence.desiredEffect,
    effectScopeKey: input.fence.effectScopeKey,
    ...(input.externalMappingOrInvocationId === undefined
      ? {}
      : { externalMappingOrInvocationId: input.externalMappingOrInvocationId }),
    mutationFenceFingerprint: fingerprintMutationFence(input.fence),
    operationId: input.operationId,
    outcome: input.outcome,
  });
}

export function isFinalZeroMutationSupersession(
  receipt: EffectReceiptEvidence,
): boolean {
  return (
    receipt.outcome === "superseded" &&
    [
      "stale_writer",
      "stale_owner",
      "superseded_by_gate",
      "superseded_by_revocation",
      "superseded_by_desired_version",
    ].includes(receipt.comparisonResult)
  );
}
