import {
  createHash,
  sign as createSignature,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

export type DisasterRecoveryCompletedEffectKind =
  | "authority_close_completed"
  | "authority_drain_completed"
  | "authority_install_ack_completed"
  | "authority_inventory_completed"
  | "erasure_replay_completed"
  | "execution_reconciliation_completed"
  | "external_inventory_reconciled"
  | "restore_completed";

export interface DisasterRecoveryCompletedEffectReceipt {
  readonly contractVersion: number;
  readonly receiptId: string;
  readonly operationId: string;
  readonly effectKind: DisasterRecoveryCompletedEffectKind;
  readonly subjectId: string;
  readonly relatedSubjectIds: readonly string[];
  readonly bindings: Readonly<Record<string, string | number>>;
  readonly outputDigest: string;
  readonly completedAt: number;
  readonly notAfter: number;
  readonly durableSequence: number;
  readonly nonce: string;
  readonly evidenceDigest: string;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
}

export interface DisasterRecoveryCompletedEffectTrust {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly authorizedSignerKeyIds: Readonly<
    Record<DisasterRecoveryCompletedEffectKind, ReadonlySet<string>>
  >;
}

interface UntrustedCompletedEffectReceipt {
  readonly contractVersion?: unknown;
  readonly receiptId?: unknown;
  readonly operationId?: unknown;
  readonly effectKind?: unknown;
  readonly subjectId?: unknown;
  readonly relatedSubjectIds?: unknown;
  readonly bindings?: unknown;
  readonly outputDigest?: unknown;
  readonly completedAt?: unknown;
  readonly notAfter?: unknown;
  readonly durableSequence?: unknown;
  readonly nonce?: unknown;
  readonly evidenceDigest?: unknown;
  readonly signerKeyId?: unknown;
  readonly signatureBase64Url?: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => key !== "signatureBase64Url")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function disasterRecoveryCompletedEffectEvidenceDigest(
  receipt: Omit<
    DisasterRecoveryCompletedEffectReceipt,
    "evidenceDigest" | "signatureBase64Url"
  >,
): string {
  return createHash("sha256").update(canonical(receipt)).digest("hex");
}

export function signDisasterRecoveryCompletedEffectReceipt(
  receipt: Omit<
    DisasterRecoveryCompletedEffectReceipt,
    "evidenceDigest" | "signatureBase64Url"
  >,
  privateKey: KeyObject,
): DisasterRecoveryCompletedEffectReceipt {
  const unsigned = Object.freeze({
    ...receipt,
    bindings: Object.freeze({ ...receipt.bindings }),
    evidenceDigest: disasterRecoveryCompletedEffectEvidenceDigest(receipt),
    relatedSubjectIds: Object.freeze([...receipt.relatedSubjectIds]),
  });
  return Object.freeze({
    ...unsigned,
    signatureBase64Url: createSignature(
      null,
      Buffer.from(canonical(unsigned), "utf8"),
      privateKey,
    ).toString("base64url"),
  });
}

function isSafeText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.normalize("NFC") &&
    !/\p{Cc}/u.test(value)
  );
}

function isBindingValue(value: unknown): value is string | number {
  return (
    isSafeText(value) ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
  );
}

function isSafeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

const completedEffectReceiptKeys = Object.freeze(
  [
    "bindings",
    "completedAt",
    "contractVersion",
    "durableSequence",
    "effectKind",
    "evidenceDigest",
    "nonce",
    "notAfter",
    "operationId",
    "outputDigest",
    "receiptId",
    "relatedSubjectIds",
    "signatureBase64Url",
    "signerKeyId",
    "subjectId",
  ].sort(),
);

export function verifyDisasterRecoveryCompletedEffectReceipt(
  value: unknown,
  input: Readonly<{
    operationId: string;
    effectKind: DisasterRecoveryCompletedEffectKind;
    trust: DisasterRecoveryCompletedEffectTrust;
    now: number;
  }>,
): DisasterRecoveryCompletedEffectReceipt {
  if (value === null || typeof value !== "object")
    throw new Error("recovery_completed_effect_receipt_invalid");
  const receipt = value as UntrustedCompletedEffectReceipt;
  const unsignedReceipt = Object.fromEntries(
    Object.entries(receipt).filter(
      ([key]) => key !== "evidenceDigest" && key !== "signatureBase64Url",
    ),
  );
  const related = receipt.relatedSubjectIds;
  const bindings = receipt.bindings;
  const key = isSafeText(receipt.signerKeyId)
    ? input.trust.keys.get(receipt.signerKeyId)
    : undefined;
  if (
    JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(completedEffectReceiptKeys) ||
    receipt.contractVersion !== 1 ||
    receipt.operationId !== input.operationId ||
    receipt.effectKind !== input.effectKind ||
    !isSafeText(receipt.receiptId) ||
    !isSafeText(receipt.subjectId) ||
    !Array.isArray(related) ||
    !related.every(isSafeText) ||
    new Set(related).size !== related.length ||
    bindings === null ||
    typeof bindings !== "object" ||
    Array.isArray(bindings) ||
    !Object.entries(bindings).every(
      ([name, binding]) => isSafeText(name) && isBindingValue(binding),
    ) ||
    !/^[a-f0-9]{64}$/u.test(String(receipt.outputDigest)) ||
    !isSafeRevision(receipt.completedAt) ||
    !isSafeRevision(receipt.notAfter) ||
    !isSafeRevision(receipt.durableSequence) ||
    receipt.durableSequence < 1 ||
    !isSafeText(receipt.nonce) ||
    receipt.nonce.length < 16 ||
    input.now < receipt.completedAt ||
    input.now >= receipt.notAfter ||
    receipt.notAfter - receipt.completedAt > 5 * 60 * 1000 ||
    !/^[a-f0-9]{64}$/u.test(String(receipt.evidenceDigest)) ||
    receipt.evidenceDigest !==
      disasterRecoveryCompletedEffectEvidenceDigest(
        unsignedReceipt as unknown as Omit<
          DisasterRecoveryCompletedEffectReceipt,
          "evidenceDigest" | "signatureBase64Url"
        >,
      ) ||
    !isSafeText(receipt.signerKeyId) ||
    !input.trust.authorizedSignerKeyIds[input.effectKind].has(
      receipt.signerKeyId,
    ) ||
    key === undefined ||
    typeof receipt.signatureBase64Url !== "string" ||
    !verifySignature(
      null,
      Buffer.from(canonical(receipt), "utf8"),
      key,
      Buffer.from(receipt.signatureBase64Url, "base64url"),
    )
  )
    throw new Error("recovery_completed_effect_receipt_invalid");
  return receipt as unknown as DisasterRecoveryCompletedEffectReceipt;
}
