import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  mutationFenceComparisonFields,
  validateMutationRequest,
  type EffectReceiptEvidence,
  type MutateHyperQueueRequest,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import { fingerprint } from "./gateway-registry-runtime.js";

function exactReceiptKeys(receipt: EffectReceiptEvidence): boolean {
  const expected = [
    "authorityId",
    "authorityRegistrySequence",
    "comparisonFields",
    "comparisonResult",
    "effectKind",
    "effectScopeKey",
    "mutationFence",
    "mutationFenceFingerprint",
    "operationId",
    "outcome",
    "reason",
    ...(receipt.externalMappingOrInvocationId === undefined
      ? []
      : ["externalMappingOrInvocationId"]),
  ];
  return Object.keys(receipt).sort().join() === expected.sort().join();
}

function boundedText(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

export function validateRecoveredCliIntent(
  request: MutateHyperQueueRequest,
  requestFingerprint: string,
): void {
  validateMutationRequest(request);
  if (requestFingerprint !== fingerprint(request))
    throw new Error("gateway_cli_intent_fingerprint_mismatch");
}

export function validateRecoveredEffectReceipt(
  receipt: EffectReceiptEvidence,
  request: MutateHyperQueueRequest,
  authorityId: string,
  sequence: number,
): void {
  const recoveredFence: MutationFence = receipt.mutationFence;
  const outcomes = new Set([
    "applied",
    "already_applied",
    "rejected",
    "superseded",
    "unknown",
  ]);
  if (
    !exactReceiptKeys(receipt) ||
    receipt.authorityId !== authorityId ||
    receipt.authorityRegistrySequence !== sequence ||
    receipt.operationId !== request.operationId ||
    receipt.effectKind !== request.scope.effectKind ||
    receipt.effectScopeKey !== request.mutationFence.effectScopeKey ||
    receipt.mutationFenceFingerprint !== request.mutationFenceFingerprint ||
    fingerprintMutationFence(recoveredFence) !==
      request.mutationFenceFingerprint ||
    fingerprint(receipt.comparisonFields) !==
      fingerprint(mutationFenceComparisonFields(request.mutationFence)) ||
    !outcomes.has(receipt.outcome) ||
    !boundedText(receipt.comparisonResult) ||
    !boundedText(receipt.reason) ||
    (receipt.externalMappingOrInvocationId !== undefined &&
      !boundedText(receipt.externalMappingOrInvocationId))
  )
    throw new Error("gateway_receipt_without_intent");
}
