import type { EffectReceiptEvidence } from "../domain/effect-receipt.js";
import { createEffectReceipt } from "../domain/effect-receipt.js";
import type {
  FenceAuthoritySnapshot,
  MutationFence,
} from "@workload-funnel/kernel";
import {
  compareMutationFence,
  fingerprintMutationFence,
} from "@workload-funnel/kernel";

export interface ConditionalEffectCommand {
  readonly operationId: string;
  readonly fence: MutationFence;
}

export interface EffectReceiptStore {
  get(operationId: string): EffectReceiptEvidence | undefined;
  save(receipt: EffectReceiptEvidence): EffectReceiptEvidence;
}

export interface ConditionalEffectAdapter {
  apply(command: ConditionalEffectCommand): Readonly<{
    outcome: "applied" | "already_applied" | "unknown";
    externalMappingOrInvocationId?: string;
  }>;
}

export function handleConditionalEffect(
  command: ConditionalEffectCommand,
  authority: Readonly<{
    id: string;
    registrySequence: number;
    snapshot: FenceAuthoritySnapshot;
  }>,
  now: number,
  receipts: EffectReceiptStore,
  adapter: ConditionalEffectAdapter,
): EffectReceiptEvidence {
  const prior = receipts.get(command.operationId);
  if (prior !== undefined) {
    if (
      prior.mutationFenceFingerprint !== fingerprintMutationFence(command.fence)
    ) {
      throw new Error("operation_receipt_conflict");
    }
    return prior;
  }
  const comparison = compareMutationFence(
    command.fence,
    authority.snapshot,
    now,
  );
  if (comparison !== "current") {
    const superseded = [
      "stale_writer",
      "stale_owner",
      "superseded_by_gate",
      "superseded_by_revocation",
      "superseded_by_desired_version",
    ].includes(comparison);
    return receipts.save(
      createEffectReceipt({
        authorityId: authority.id,
        authorityRegistrySequence: authority.registrySequence,
        comparisonResult: comparison,
        fence: command.fence,
        operationId: command.operationId,
        outcome: superseded ? "superseded" : "rejected",
      }),
    );
  }
  const result = adapter.apply(command);
  return receipts.save(
    createEffectReceipt({
      authorityId: authority.id,
      authorityRegistrySequence: authority.registrySequence,
      comparisonResult: "current",
      fence: command.fence,
      operationId: command.operationId,
      outcome: result.outcome,
      ...(result.externalMappingOrInvocationId === undefined
        ? {}
        : {
            externalMappingOrInvocationId: result.externalMappingOrInvocationId,
          }),
    }),
  );
}
