import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import type { EffectReceiptEvidence } from "../domain/effect-receipt.js";
import type { Execution } from "../domain/execution.js";

export interface SealOutputIntent {
  readonly operationId: string;
  readonly quiescenceReceiptDigest: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly state: "requested" | "sealed" | "unknown";
  readonly sealId?: string;
  readonly treeDigest?: string;
}

export type ExecutionWithSealOutput = Execution &
  Readonly<{
    sealOutput?: SealOutputIntent;
  }>;

export function requestSealOutput(
  execution: ExecutionWithSealOutput,
  input: Readonly<{
    operationId: string;
    quiescenceReceiptDigest: string;
    mutationFence: MutationFence;
  }>,
): ExecutionWithSealOutput {
  validateMutationFence(input.mutationFence);
  const fence = input.mutationFence;
  if (
    !["exited", "stopped"].includes(execution.state) ||
    !/^[a-f0-9]{64}$/u.test(input.quiescenceReceiptDigest) ||
    fence.desiredEffect !== "seal_output" ||
    fence.requiredGate !== "result_finalize" ||
    fence.allocationId !== execution.allocationId ||
    fence.attemptId !== execution.attemptId ||
    fence.executionGeneration !== execution.executionGeneration ||
    fence.effectScopeKey !== `seal-output:${execution.executionId}`
  )
    throw new Error("seal_output_intent_invalid");
  const prior = execution.sealOutput;
  const mutationFenceFingerprint = fingerprintMutationFence(fence);
  if (prior !== undefined) {
    if (
      prior.operationId !== input.operationId ||
      prior.mutationFenceFingerprint !== mutationFenceFingerprint
    ) {
      throw new Error("seal_output_intent_conflict");
    }
    return execution;
  }
  return Object.freeze({
    ...execution,
    sealOutput: Object.freeze({
      mutationFence: fence,
      mutationFenceFingerprint,
      operationId: input.operationId,
      quiescenceReceiptDigest: input.quiescenceReceiptDigest,
      state: "requested",
    }),
    version: execution.version + 1,
  });
}

export function applySealOutputReceipt(
  execution: ExecutionWithSealOutput,
  input: Readonly<{
    receipt: EffectReceiptEvidence;
    sealId?: string;
    treeDigest?: string;
  }>,
): ExecutionWithSealOutput {
  const intent = execution.sealOutput;
  if (
    input.receipt.operationId !== intent?.operationId ||
    input.receipt.effectKind !== "seal_output" ||
    input.receipt.mutationFenceFingerprint !== intent.mutationFenceFingerprint
  )
    throw new Error("seal_output_receipt_mismatch");
  if (intent.state !== "requested") return execution;
  const sealed = ["applied", "already_applied"].includes(input.receipt.outcome);
  if (
    sealed &&
    (!input.sealId || !/^[a-f0-9]{64}$/u.test(input.treeDigest ?? ""))
  ) {
    throw new Error("seal_output_receipt_missing_seal_identity");
  }
  return Object.freeze({
    ...execution,
    sealOutput: Object.freeze({
      ...intent,
      ...(input.sealId === undefined ? {} : { sealId: input.sealId }),
      ...(input.treeDigest === undefined
        ? {}
        : { treeDigest: input.treeDigest }),
      state: sealed ? "sealed" : "unknown",
    }),
    version: execution.version + 1,
  });
}
