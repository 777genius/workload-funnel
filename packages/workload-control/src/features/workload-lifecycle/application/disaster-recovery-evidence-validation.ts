import {
  verifyDisasterRecoveryCompletedEffectReceipt,
  type DisasterRecoveryCompletedEffectKind,
  type DisasterRecoveryCompletedEffectReceipt,
} from "./disaster-recovery-effect-evidence.js";
import { DisasterRecoveryError } from "./disaster-recovery-errors.js";
import type {
  DisasterRecoveryEffectPayload,
  DisasterRecoveryEffectReceipt,
  DisasterRecoveryEffectTrust,
  DisasterRecoveryOperation,
} from "./disaster-recovery.js";

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((item) => typeof item === "string") &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function completedEffectReceipt(
  value: unknown,
  input: Readonly<{
    operationId: string;
    effectKind: DisasterRecoveryCompletedEffectKind;
    trust: DisasterRecoveryEffectTrust;
    now: number;
    errorCode: string;
  }>,
): DisasterRecoveryCompletedEffectReceipt {
  try {
    return verifyDisasterRecoveryCompletedEffectReceipt(value, {
      effectKind: input.effectKind,
      now: input.now,
      operationId: input.operationId,
      trust: input.trust.completedEffects,
    });
  } catch {
    throw new DisasterRecoveryError(input.errorCode);
  }
}

function completedEffectReceipts(
  value: unknown,
  input: Parameters<typeof completedEffectReceipt>[1],
): readonly DisasterRecoveryCompletedEffectReceipt[] {
  if (!Array.isArray(value)) throw new DisasterRecoveryError(input.errorCode);
  const receipts = value.map((item) => completedEffectReceipt(item, input));
  if (
    new Set(receipts.map((receipt) => receipt.receiptId)).size !==
      receipts.length ||
    new Set(receipts.map((receipt) => receipt.nonce)).size !==
      receipts.length ||
    new Set(receipts.map((receipt) => receipt.subjectId)).size !==
      receipts.length
  )
    throw new DisasterRecoveryError(input.errorCode);
  return Object.freeze(receipts);
}

export function completedEffectBindingText(
  receipt: DisasterRecoveryCompletedEffectReceipt,
  key: string,
): string | undefined {
  const value = receipt.bindings[key];
  return typeof value === "string" ? value : undefined;
}

export function completedEffectBindingRevision(
  receipt: DisasterRecoveryCompletedEffectReceipt,
  key: string,
): number | undefined {
  const value = receipt.bindings[key];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function exactReceiptSubjects(
  receipts: readonly DisasterRecoveryCompletedEffectReceipt[],
  expected: readonly string[],
): boolean {
  return exactStrings(
    receipts.map((receipt) => receipt.subjectId),
    expected,
  );
}

export function validateRestoreCompletedEffectEvidence(
  operationId: string,
  payload: DisasterRecoveryEffectPayload,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): DisasterRecoveryCompletedEffectReceipt {
  return completedEffectReceipt(payload.restoreEffectReceipt, {
    effectKind: "restore_completed",
    errorCode: "restore_receipt_evidence_mismatch",
    now,
    operationId,
    trust: effectTrust,
  });
}

const finalAuthorityKinds = Object.freeze([
  "artifact-store",
  "node-launcher",
  "result-sealer",
  "runtime-broker",
  "scheduler-gateway",
] as const);

export function validateFinalAuthorityEffectEvidence(
  operation: DisasterRecoveryOperation,
  payload: DisasterRecoveryEffectPayload,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): void {
  const errorCode = "recovery_authority_evidence_incomplete";
  const inventory = completedEffectReceipt(
    payload.authorityInventoryEffectReceipt,
    {
      effectKind: "authority_inventory_completed",
      errorCode,
      now,
      operationId: operation.operationId,
      trust: effectTrust,
    },
  );
  const targets = inventory.relatedSubjectIds;
  if (
    targets.length < finalAuthorityKinds.length ||
    finalAuthorityKinds.some(
      (kind) => !targets.some((target) => target.startsWith(`${kind}:`)),
    ) ||
    completedEffectBindingRevision(inventory, "targetCount") !==
      targets.length ||
    completedEffectBindingText(inventory, "inventoryDigest") !==
      inventory.outputDigest
  )
    throw new DisasterRecoveryError(errorCode);
  const common = {
    errorCode,
    now,
    operationId: operation.operationId,
    trust: effectTrust,
  } as const;
  const closes = completedEffectReceipts(payload.authorityCloseEffectReceipts, {
    ...common,
    effectKind: "authority_close_completed",
  });
  const drains = completedEffectReceipts(payload.authorityDrainEffectReceipts, {
    ...common,
    effectKind: "authority_drain_completed",
  });
  const installs = completedEffectReceipts(
    payload.authorityInstallEffectReceipts,
    { ...common, effectKind: "authority_install_ack_completed" },
  );
  const allReceipts = [inventory, ...closes, ...drains, ...installs];
  if (
    !exactReceiptSubjects(closes, targets) ||
    !exactReceiptSubjects(drains, targets) ||
    !exactReceiptSubjects(installs, targets) ||
    new Set(allReceipts.map((receipt) => receipt.receiptId)).size !==
      allReceipts.length ||
    new Set(allReceipts.map((receipt) => receipt.nonce)).size !==
      allReceipts.length
  )
    throw new DisasterRecoveryError(errorCode);
  for (const target of targets) {
    const close = closes.find((receipt) => receipt.subjectId === target);
    const drain = drains.find((receipt) => receipt.subjectId === target);
    const install = installs.find((receipt) => receipt.subjectId === target);
    if (
      close === undefined ||
      drain === undefined ||
      install === undefined ||
      completedEffectBindingText(close, "inventoryReceiptId") !==
        inventory.receiptId ||
      completedEffectBindingText(close, "effectScopeKey") === undefined ||
      completedEffectBindingText(drain, "closeReceiptId") !== close.receiptId ||
      completedEffectBindingText(install, "drainReceiptId") !==
        drain.receiptId ||
      !/^fence-v1-[a-f0-9]{64}$/u.test(
        completedEffectBindingText(install, "mutationFenceFingerprint") ?? "",
      ) ||
      !/^[a-f0-9]{64}$/u.test(
        completedEffectBindingText(install, "highWatermarksDigest") ?? "",
      )
    )
      throw new DisasterRecoveryError(errorCode);
  }
}

export function externalInventoryEffectReceipt(
  operation: DisasterRecoveryOperation,
  payload: DisasterRecoveryEffectPayload,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): DisasterRecoveryCompletedEffectReceipt {
  const receipt = completedEffectReceipt(
    payload.externalInventoryEffectReceipt,
    {
      effectKind: "external_inventory_reconciled",
      errorCode: "recovery_inventory_incomplete",
      now,
      operationId: operation.operationId,
      trust: effectTrust,
    },
  );
  if (
    completedEffectBindingText(receipt, "inventoryDigest") !==
    receipt.outputDigest
  )
    throw new DisasterRecoveryError("recovery_inventory_incomplete");
  return receipt;
}

export function validateErasureEffectEvidence(
  operation: DisasterRecoveryOperation,
  payload: DisasterRecoveryEffectPayload,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): void {
  const receipt = completedEffectReceipt(payload.erasureReplayEffectReceipt, {
    effectKind: "erasure_replay_completed",
    errorCode: "recovery_erasure_receipt_incomplete",
    now,
    operationId: operation.operationId,
    trust: effectTrust,
  });
  if (
    completedEffectBindingRevision(receipt, "erasureHighWatermark") !==
    operation.externalErasureHighWatermark
  )
    throw new DisasterRecoveryError("recovery_erasure_receipt_incomplete");
}

export function validateExecutionReconciliationEffectEvidence(
  operation: DisasterRecoveryOperation,
  payload: DisasterRecoveryEffectPayload,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): void {
  const inventoryStep = operation.receipts.find(
    (receipt) => receipt.effect === "external_inventory_reconciled",
  );
  if (inventoryStep === undefined)
    throw new DisasterRecoveryError("recovery_execution_receipt_incomplete");
  const inventory = externalInventoryEffectReceipt(
    operation,
    inventoryStep.payload,
    effectTrust,
    inventoryStep.completedAt,
  );
  const receipts = completedEffectReceipts(
    payload.executionReconciliationEffectReceipts,
    {
      effectKind: "execution_reconciliation_completed",
      errorCode: "recovery_execution_receipt_incomplete",
      now,
      operationId: operation.operationId,
      trust: effectTrust,
    },
  );
  if (!exactReceiptSubjects(receipts, inventory.relatedSubjectIds))
    throw new DisasterRecoveryError("recovery_execution_receipt_incomplete");
  for (const receipt of receipts)
    if (
      !new Set([
        "adopted",
        "canonical_terminal",
        "escalated",
        "signed_absence",
        "stopped",
      ]).has(completedEffectBindingText(receipt, "proofKind") ?? "")
    )
      throw new DisasterRecoveryError("recovery_execution_receipt_incomplete");
}

export function revalidatePersistedCompletedEffectEvidence(
  operation: DisasterRecoveryOperation,
  receipt: DisasterRecoveryEffectReceipt,
  effectTrust: DisasterRecoveryEffectTrust,
): void {
  const now = receipt.completedAt;
  switch (receipt.effect) {
    case "restore_quarantine":
      validateRestoreCompletedEffectEvidence(
        operation.operationId,
        receipt.payload,
        effectTrust,
        now,
      );
      break;
    case "final_authorities_installed":
      validateFinalAuthorityEffectEvidence(
        operation,
        receipt.payload,
        effectTrust,
        now,
      );
      break;
    case "external_inventory_reconciled":
      externalInventoryEffectReceipt(
        operation,
        receipt.payload,
        effectTrust,
        now,
      );
      break;
    case "erasure_ledger_replayed":
      validateErasureEffectEvidence(
        operation,
        receipt.payload,
        effectTrust,
        now,
      );
      break;
    case "executions_reconciled":
      validateExecutionReconciliationEffectEvidence(
        operation,
        receipt.payload,
        effectTrust,
        now,
      );
      break;
    case "admission_approved":
    case "cluster_authority_rotated":
    case "nodes_reenrolled":
    case "projections_rebuilt":
      break;
  }
}
