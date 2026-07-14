import {
  createHash,
  sign as createSignature,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import type { DurabilityProfile } from "../domain/durability.js";
import type { DisasterRecoveryCompletedEffectTrust } from "./disaster-recovery-effect-evidence.js";
import { DisasterRecoveryError } from "./disaster-recovery-errors.js";
import {
  completedEffectBindingRevision,
  completedEffectBindingText,
  externalInventoryEffectReceipt,
  revalidatePersistedCompletedEffectEvidence,
  validateErasureEffectEvidence,
  validateExecutionReconciliationEffectEvidence,
  validateFinalAuthorityEffectEvidence,
  validateRestoreCompletedEffectEvidence,
} from "./disaster-recovery-evidence-validation.js";

export type CanonicalHistoryKind = "accepted" | "terminal";

export interface CanonicalHistoryRecord {
  readonly streamSequence: number;
  readonly kind: CanonicalHistoryKind;
  readonly workloadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly canonicalDigest: string;
}

export interface WorkloadBackupManifest {
  readonly contractVersion: "workload-funnel.backup-manifest/v1";
  readonly backupId: string;
  readonly createdAt: number;
  readonly clusterIncarnation: string;
  readonly durabilityProfile: DurabilityProfile;
  readonly databaseSchemaVersion: number;
  readonly streamCut: number;
  readonly acceptanceHighWatermark: number;
  readonly auditHighWatermark: number;
  readonly erasureLedgerHighWatermark: number;
  readonly acceptedCount: number;
  readonly terminalCount: number;
  readonly canonicalHistoryDigest: string;
}

export type DisasterRecoveryStep =
  | "restore_quarantine"
  | "cluster_authority_rotated"
  | "final_authorities_installed"
  | "external_inventory_reconciled"
  | "projections_rebuilt"
  | "erasure_ledger_replayed"
  | "executions_reconciled"
  | "nodes_reenrolled"
  | "admission_approved";

export interface DisasterRecoveryEffectPayload {
  readonly backupId?: unknown;
  readonly restoredHistoryDigest?: unknown;
  readonly streamCut?: unknown;
  readonly closedGates?: unknown;
  readonly restoredDatabaseDigest?: unknown;
  readonly restoreEffectReceipt?: unknown;
  readonly previousClusterIncarnation?: unknown;
  readonly clusterIncarnation?: unknown;
  readonly clusterIncarnationVersion?: unknown;
  readonly namespaceWriterEpoch?: unknown;
  readonly ticketSigningAuthorityId?: unknown;
  readonly authorityInventoryEffectReceipt?: unknown;
  readonly authorityCloseEffectReceipts?: unknown;
  readonly authorityDrainEffectReceipts?: unknown;
  readonly authorityInstallEffectReceipts?: unknown;
  readonly externalInventoryEffectReceipt?: unknown;
  readonly outboxReplayComplete?: unknown;
  readonly projectionCheckpointsReset?: unknown;
  readonly erasureHighWatermark?: unknown;
  readonly erasureReplayEffectReceipt?: unknown;
  readonly executionReconciliationEffectReceipts?: unknown;
  readonly enrolledNodeCount?: unknown;
  readonly credentialGeneration?: unknown;
  readonly oldCredentialsDisabled?: unknown;
  readonly approvedBy?: unknown;
  readonly approvalId?: unknown;
  readonly observationContinuity?: unknown;
  readonly cancellationContinuity?: unknown;
}

export interface DisasterRecoveryEffectReceipt {
  readonly contractVersion: number;
  readonly receiptId: string;
  readonly operationId: string;
  readonly effect: DisasterRecoveryStep;
  readonly completedAt: number;
  readonly notAfter: number;
  readonly durableSequence: number;
  readonly nonce: string;
  readonly evidenceDigest: string;
  readonly payload: DisasterRecoveryEffectPayload;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
}

export interface DisasterRecoveryEffectTrust {
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly authorizedSignerKeyIds: Readonly<
    Record<DisasterRecoveryStep, ReadonlySet<string>>
  >;
  readonly completedEffects: DisasterRecoveryCompletedEffectTrust;
}

export interface DisasterRecoveryOperation {
  readonly operationId: string;
  readonly backupManifest: WorkloadBackupManifest;
  readonly restoredHistory: readonly CanonicalHistoryRecord[];
  readonly recoveredHistoryDigest: string;
  readonly externalAcceptanceHighWatermark: number;
  readonly externalAuditHighWatermark: number;
  readonly externalErasureHighWatermark: number;
  readonly step: DisasterRecoveryStep;
  readonly closedGates: readonly string[];
  readonly receipts: readonly DisasterRecoveryEffectReceipt[];
  readonly version: number;
}

export interface DisasterRecoveryStore {
  create(operation: DisasterRecoveryOperation): DisasterRecoveryOperation;
  get(operationId: string): DisasterRecoveryOperation | undefined;
  compareAndSet(
    expectedVersion: number,
    operation: DisasterRecoveryOperation,
  ): DisasterRecoveryOperation;
}

export { DisasterRecoveryError } from "./disaster-recovery-errors.js";

const restoreClosedGates = Object.freeze([
  "acceptance",
  "admission_reservation",
  "automatic_retry",
  "dispatch_submit",
  "process_start",
  "result_archive",
  "result_delete",
  "result_finalize",
] as const);

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

export function signDisasterRecoveryEffectReceipt(
  receipt: Omit<
    DisasterRecoveryEffectReceipt,
    "evidenceDigest" | "signatureBase64Url"
  >,
  privateKey: KeyObject,
): DisasterRecoveryEffectReceipt {
  const unsigned = Object.freeze({
    ...receipt,
    evidenceDigest: disasterRecoveryEffectEvidenceDigest(receipt),
  });
  return Object.freeze({
    ...unsigned,
    payload: Object.freeze({ ...receipt.payload }),
    signatureBase64Url: createSignature(
      null,
      Buffer.from(canonical(unsigned), "utf8"),
      privateKey,
    ).toString("base64url"),
  });
}

export function disasterRecoveryEffectEvidenceDigest(
  receipt: Omit<
    DisasterRecoveryEffectReceipt,
    "evidenceDigest" | "signatureBase64Url"
  >,
): string {
  const fields = receipt as Partial<DisasterRecoveryEffectReceipt>;
  const unsigned = Object.freeze({
    completedAt: fields.completedAt,
    contractVersion: fields.contractVersion,
    durableSequence: fields.durableSequence,
    effect: fields.effect,
    nonce: fields.nonce,
    notAfter: fields.notAfter,
    operationId: fields.operationId,
    payload: fields.payload,
    receiptId: fields.receiptId,
    signerKeyId: fields.signerKeyId,
  });
  return createHash("sha256").update(canonical(unsigned)).digest("hex");
}

function verifyEffectReceipt(
  receipt: DisasterRecoveryEffectReceipt,
  operationId: string,
  effect: DisasterRecoveryStep,
  trust: DisasterRecoveryEffectTrust,
  now: number,
): void {
  const key = trust.keys.get(receipt.signerKeyId);
  if (
    receipt.contractVersion !== 1 ||
    receipt.operationId !== operationId ||
    receipt.effect !== effect ||
    receipt.receiptId.length < 1 ||
    receipt.nonce.length < 16 ||
    receipt.durableSequence < 1 ||
    receipt.evidenceDigest !== disasterRecoveryEffectEvidenceDigest(receipt) ||
    now < receipt.completedAt ||
    now >= receipt.notAfter ||
    receipt.notAfter - receipt.completedAt > 5 * 60 * 1000 ||
    !trust.authorizedSignerKeyIds[effect].has(receipt.signerKeyId) ||
    key === undefined ||
    !verifySignature(
      null,
      Buffer.from(canonical(receipt), "utf8"),
      key,
      Buffer.from(receipt.signatureBase64Url, "base64url"),
    )
  )
    throw new DisasterRecoveryError("recovery_effect_receipt_invalid");
}

function exactStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.every((item) => typeof item === "string") &&
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function validateText(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value)
  )
    throw new DisasterRecoveryError(`invalid_${field}`);
}

function validateRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new DisasterRecoveryError(`invalid_${field}`);
}

function canonicalHistory(
  history: readonly CanonicalHistoryRecord[],
): readonly CanonicalHistoryRecord[] {
  let previousSequence = 0;
  const accepted = new Map<string, CanonicalHistoryRecord>();
  const terminal = new Map<string, CanonicalHistoryRecord>();
  const result = history.map((record) => {
    validateRevision(record.streamSequence, "history_sequence");
    if (record.streamSequence <= previousSequence)
      throw new DisasterRecoveryError("history_sequence_not_strict");
    previousSequence = record.streamSequence;
    for (const [field, value] of Object.entries({
      attempt_id: record.attemptId,
      canonical_digest: record.canonicalDigest,
      run_id: record.runId,
      workload_id: record.workloadId,
    }))
      validateText(value, field);
    const key = `${record.workloadId}\u0000${record.runId}`;
    if (record.kind === "accepted") {
      if (accepted.has(key))
        throw new DisasterRecoveryError("duplicate_accepted_history");
      accepted.set(key, record);
    } else {
      if (terminal.has(key))
        throw new DisasterRecoveryError("duplicate_terminal_history");
      const acceptance = accepted.get(key);
      if (acceptance?.attemptId !== record.attemptId)
        throw new DisasterRecoveryError("terminal_without_matching_acceptance");
      terminal.set(key, record);
    }
    return Object.freeze({ ...record });
  });
  return Object.freeze(result);
}

function validateBackupManifest(
  manifest: WorkloadBackupManifest,
  history: readonly CanonicalHistoryRecord[],
  code = "backup_manifest_invalid",
): void {
  validateText(manifest.backupId, "backup_id");
  validateText(manifest.clusterIncarnation, "cluster_incarnation");
  for (const [field, value] of Object.entries({
    acceptance_high_watermark: manifest.acceptanceHighWatermark,
    accepted_count: manifest.acceptedCount,
    audit_high_watermark: manifest.auditHighWatermark,
    created_at: manifest.createdAt,
    database_schema_version: manifest.databaseSchemaVersion,
    erasure_ledger_high_watermark: manifest.erasureLedgerHighWatermark,
    stream_cut: manifest.streamCut,
    terminal_count: manifest.terminalCount,
  }))
    validateRevision(value, field);
  const acceptedCount = history.filter(
    (record) => record.kind === "accepted",
  ).length;
  const terminalCount = history.filter(
    (record) => record.kind === "terminal",
  ).length;
  const streamCut = history.at(-1)?.streamSequence ?? 0;
  const contractVersion = (manifest as Readonly<{ contractVersion: unknown }>)
    .contractVersion;
  if (
    contractVersion !== "workload-funnel.backup-manifest/v1" ||
    !new Set<DurabilityProfile>([
      "single_node_durable",
      "synchronous_ha",
      "externally_witnessed",
    ]).has(manifest.durabilityProfile) ||
    manifest.databaseSchemaVersion < 1 ||
    !/^[a-f0-9]{64}$/u.test(manifest.canonicalHistoryDigest) ||
    manifest.canonicalHistoryDigest !== canonicalHistoryDigest(history) ||
    manifest.streamCut !== streamCut ||
    manifest.acceptedCount !== acceptedCount ||
    manifest.terminalCount !== terminalCount ||
    manifest.acceptanceHighWatermark < acceptedCount ||
    manifest.auditHighWatermark < streamCut
  )
    throw new DisasterRecoveryError(code);
}

export function canonicalHistoryDigest(
  history: readonly CanonicalHistoryRecord[],
): string {
  const records = canonicalHistory(history);
  const hash = createHash("sha256");
  for (const record of records) {
    const fields = [
      record.streamSequence,
      record.kind,
      record.workloadId,
      record.runId,
      record.attemptId,
      record.canonicalDigest,
    ];
    for (const field of fields) {
      const value = String(field).normalize("NFC");
      hash.update(`${String(Buffer.byteLength(value))}:${value}`);
    }
  }
  return hash.digest("hex");
}

export function createWorkloadBackupManifest(
  input: Readonly<{
    backupId: string;
    createdAt: number;
    clusterIncarnation: string;
    durabilityProfile: DurabilityProfile;
    databaseSchemaVersion: number;
    acceptanceHighWatermark: number;
    auditHighWatermark: number;
    erasureLedgerHighWatermark: number;
    history: readonly CanonicalHistoryRecord[];
  }>,
): WorkloadBackupManifest {
  validateText(input.backupId, "backup_id");
  validateText(input.clusterIncarnation, "cluster_incarnation");
  for (const [field, value] of Object.entries({
    acceptance_high_watermark: input.acceptanceHighWatermark,
    audit_high_watermark: input.auditHighWatermark,
    created_at: input.createdAt,
    database_schema_version: input.databaseSchemaVersion,
    erasure_ledger_high_watermark: input.erasureLedgerHighWatermark,
  }))
    validateRevision(value, field);
  const history = canonicalHistory(input.history);
  const streamCut = history.at(-1)?.streamSequence ?? 0;
  if (
    input.acceptanceHighWatermark <
      history.filter((record) => record.kind === "accepted").length ||
    input.auditHighWatermark < streamCut
  )
    throw new DisasterRecoveryError("backup_watermark_behind_history");
  const manifest: WorkloadBackupManifest = Object.freeze({
    acceptanceHighWatermark: input.acceptanceHighWatermark,
    acceptedCount: history.filter((record) => record.kind === "accepted")
      .length,
    auditHighWatermark: input.auditHighWatermark,
    backupId: input.backupId,
    canonicalHistoryDigest: canonicalHistoryDigest(history),
    clusterIncarnation: input.clusterIncarnation,
    contractVersion: "workload-funnel.backup-manifest/v1",
    createdAt: input.createdAt,
    databaseSchemaVersion: input.databaseSchemaVersion,
    durabilityProfile: input.durabilityProfile,
    erasureLedgerHighWatermark: input.erasureLedgerHighWatermark,
    streamCut,
    terminalCount: history.filter((record) => record.kind === "terminal")
      .length,
  });
  validateBackupManifest(manifest, history);
  return manifest;
}

export function beginDisasterRecovery(
  input: Readonly<{
    operationId: string;
    backupManifest: WorkloadBackupManifest;
    restoredHistory: readonly CanonicalHistoryRecord[];
    externalAcceptanceHighWatermark: number;
    externalAuditHighWatermark: number;
    externalErasureHighWatermark: number;
    restoreReceipt: DisasterRecoveryEffectReceipt;
    effectTrust: DisasterRecoveryEffectTrust;
    now: number;
  }>,
): DisasterRecoveryOperation {
  validateText(input.operationId, "recovery_operation_id");
  const history = canonicalHistory(input.restoredHistory);
  const digest = canonicalHistoryDigest(history);
  validateBackupManifest(
    input.backupManifest,
    history,
    "restored_history_manifest_mismatch",
  );
  for (const [field, value] of Object.entries({
    external_acceptance_high_watermark: input.externalAcceptanceHighWatermark,
    external_audit_high_watermark: input.externalAuditHighWatermark,
    external_erasure_high_watermark: input.externalErasureHighWatermark,
  }))
    validateRevision(value, field);
  if (
    input.backupManifest.canonicalHistoryDigest !== digest ||
    input.backupManifest.streamCut !== (history.at(-1)?.streamSequence ?? 0) ||
    input.backupManifest.acceptedCount !==
      history.filter((record) => record.kind === "accepted").length ||
    input.backupManifest.terminalCount !==
      history.filter((record) => record.kind === "terminal").length
  )
    throw new DisasterRecoveryError("restored_history_manifest_mismatch");
  verifyEffectReceipt(
    input.restoreReceipt,
    input.operationId,
    "restore_quarantine",
    input.effectTrust,
    input.now,
  );
  const restorePayload = input.restoreReceipt.payload;
  const restoreEffect = validateRestoreCompletedEffectEvidence(
    input.operationId,
    restorePayload,
    input.effectTrust,
    input.now,
  );
  if (
    restorePayload.backupId !== input.backupManifest.backupId ||
    restorePayload.restoredHistoryDigest !== digest ||
    restorePayload.streamCut !== input.backupManifest.streamCut ||
    !exactStrings(restorePayload.closedGates, restoreClosedGates) ||
    !/^[a-f0-9]{64}$/u.test(String(restorePayload.restoredDatabaseDigest)) ||
    completedEffectBindingText(restoreEffect, "backupId") !==
      input.backupManifest.backupId ||
    completedEffectBindingText(restoreEffect, "restoredHistoryDigest") !==
      digest ||
    completedEffectBindingRevision(restoreEffect, "streamCut") !==
      input.backupManifest.streamCut ||
    completedEffectBindingText(restoreEffect, "restoredDatabaseDigest") !==
      restorePayload.restoredDatabaseDigest ||
    restoreEffect.outputDigest !== restorePayload.restoredDatabaseDigest ||
    !exactStrings(restoreEffect.relatedSubjectIds, restoreClosedGates)
  )
    throw new DisasterRecoveryError("restore_receipt_evidence_mismatch");
  return Object.freeze({
    backupManifest: input.backupManifest,
    closedGates: restoreClosedGates,
    externalAcceptanceHighWatermark: input.externalAcceptanceHighWatermark,
    externalAuditHighWatermark: input.externalAuditHighWatermark,
    externalErasureHighWatermark: input.externalErasureHighWatermark,
    operationId: input.operationId,
    receipts: Object.freeze([input.restoreReceipt]),
    recoveredHistoryDigest: digest,
    restoredHistory: history,
    step: "restore_quarantine",
    version: 1,
  });
}

const recoverySteps: readonly DisasterRecoveryStep[] = Object.freeze([
  "restore_quarantine",
  "cluster_authority_rotated",
  "final_authorities_installed",
  "external_inventory_reconciled",
  "projections_rebuilt",
  "erasure_ledger_replayed",
  "executions_reconciled",
  "nodes_reenrolled",
  "admission_approved",
]);

export function advanceDisasterRecovery(
  operation: DisasterRecoveryOperation,
  next: DisasterRecoveryStep,
  receipt: DisasterRecoveryEffectReceipt,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): DisasterRecoveryOperation {
  if (recoverySteps.indexOf(next) !== recoverySteps.indexOf(operation.step) + 1)
    throw new DisasterRecoveryError("recovery_step_out_of_order");
  verifyEffectReceipt(receipt, operation.operationId, next, effectTrust, now);
  if (
    operation.receipts.some(
      (prior) =>
        prior.receiptId === receipt.receiptId || prior.nonce === receipt.nonce,
    )
  )
    throw new DisasterRecoveryError("recovery_effect_receipt_replayed");
  const payload = receipt.payload;
  switch (next) {
    case "cluster_authority_rotated":
      if (
        payload.previousClusterIncarnation !==
          operation.backupManifest.clusterIncarnation ||
        typeof payload.clusterIncarnation !== "string" ||
        payload.clusterIncarnation ===
          operation.backupManifest.clusterIncarnation ||
        !Number.isSafeInteger(payload.clusterIncarnationVersion) ||
        (payload.clusterIncarnationVersion as number) < 1 ||
        !Number.isSafeInteger(payload.namespaceWriterEpoch) ||
        (payload.namespaceWriterEpoch as number) < 1 ||
        typeof payload.ticketSigningAuthorityId !== "string"
      )
        throw new DisasterRecoveryError("recovery_cluster_receipt_incomplete");
      break;
    case "final_authorities_installed":
      validateFinalAuthorityEffectEvidence(
        operation,
        payload,
        effectTrust,
        now,
      );
      break;
    case "external_inventory_reconciled":
      externalInventoryEffectReceipt(operation, payload, effectTrust, now);
      break;
    case "projections_rebuilt":
      if (
        payload.streamCut !== operation.backupManifest.streamCut ||
        payload.outboxReplayComplete !== true ||
        payload.projectionCheckpointsReset !== true
      )
        throw new DisasterRecoveryError(
          "recovery_projection_receipt_incomplete",
        );
      break;
    case "erasure_ledger_replayed":
      validateErasureEffectEvidence(operation, payload, effectTrust, now);
      break;
    case "executions_reconciled":
      validateExecutionReconciliationEffectEvidence(
        operation,
        payload,
        effectTrust,
        now,
      );
      break;
    case "nodes_reenrolled":
      if (
        !Number.isSafeInteger(payload.enrolledNodeCount) ||
        (payload.enrolledNodeCount as number) < 1 ||
        !Number.isSafeInteger(payload.credentialGeneration) ||
        (payload.credentialGeneration as number) < 1 ||
        payload.oldCredentialsDisabled !== true
      )
        throw new DisasterRecoveryError("recovery_node_receipt_incomplete");
      break;
    case "admission_approved":
      if (
        typeof payload.approvedBy !== "string" ||
        typeof payload.approvalId !== "string" ||
        payload.observationContinuity !== true ||
        payload.cancellationContinuity !== true
      )
        throw new DisasterRecoveryError("recovery_approval_receipt_incomplete");
      break;
    case "restore_quarantine":
      throw new DisasterRecoveryError("recovery_step_out_of_order");
  }
  if (
    next === "erasure_ledger_replayed" &&
    operation.externalErasureHighWatermark <
      operation.backupManifest.erasureLedgerHighWatermark
  )
    throw new DisasterRecoveryError("erasure_ledger_watermark_regressed");
  if (next === "admission_approved") {
    let priorSequence = 0;
    const expectedPriorEffects = recoverySteps.slice(0, -1);
    if (operation.receipts.length !== expectedPriorEffects.length)
      throw new DisasterRecoveryError("recovery_prior_receipts_incomplete");
    for (const [index, prior] of operation.receipts.entries()) {
      const expectedEffect = expectedPriorEffects[index];
      if (
        expectedEffect === undefined ||
        prior.effect !== expectedEffect ||
        prior.durableSequence <= priorSequence
      )
        throw new DisasterRecoveryError("recovery_prior_receipts_incomplete");
      verifyEffectReceipt(
        prior,
        operation.operationId,
        expectedEffect,
        effectTrust,
        prior.completedAt,
      );
      revalidatePersistedCompletedEffectEvidence(operation, prior, effectTrust);
      priorSequence = prior.durableSequence;
    }
    if (
      operation.externalAcceptanceHighWatermark !==
        operation.backupManifest.acceptanceHighWatermark ||
      operation.externalAuditHighWatermark !==
        operation.backupManifest.auditHighWatermark
    )
      throw new DisasterRecoveryError("recovered_external_watermark_gap");
    if (
      canonicalHistoryDigest(operation.restoredHistory) !==
        operation.backupManifest.canonicalHistoryDigest ||
      JSON.stringify([...operation.closedGates].sort()) !==
        JSON.stringify([...restoreClosedGates].sort())
    )
      throw new DisasterRecoveryError("recovered_history_changed");
  }
  return Object.freeze({
    ...operation,
    receipts: Object.freeze([...operation.receipts, receipt]),
    step: next,
    version: operation.version + 1,
  });
}

export function assertDisasterRecoveryAdmissionOpen(
  operation: DisasterRecoveryOperation,
): void {
  if (operation.step !== "admission_approved")
    throw new DisasterRecoveryError("restore_quarantine");
}

export function beginPersistedDisasterRecovery(
  store: DisasterRecoveryStore,
  input: Parameters<typeof beginDisasterRecovery>[0],
): DisasterRecoveryOperation {
  const prior = store.get(input.operationId);
  if (prior !== undefined) {
    if (
      prior.backupManifest.backupId !== input.backupManifest.backupId ||
      prior.recoveredHistoryDigest !==
        canonicalHistoryDigest(input.restoredHistory)
    )
      throw new DisasterRecoveryError("recovery_operation_replay_conflict");
    return prior;
  }
  return store.create(beginDisasterRecovery(input));
}

export function advancePersistedDisasterRecovery(
  store: DisasterRecoveryStore,
  operationId: string,
  next: DisasterRecoveryStep,
  receipt: DisasterRecoveryEffectReceipt,
  effectTrust: DisasterRecoveryEffectTrust,
  now: number,
): DisasterRecoveryOperation {
  const current = store.get(operationId);
  if (current === undefined)
    throw new DisasterRecoveryError("recovery_operation_not_found");
  if (current.step === next) {
    const prior = current.receipts.find((item) => item.effect === next);
    if (
      prior?.receiptId === receipt.receiptId &&
      prior.signatureBase64Url === receipt.signatureBase64Url
    )
      return current;
    throw new DisasterRecoveryError("recovery_operation_replay_conflict");
  }
  return store.compareAndSet(
    current.version,
    advanceDisasterRecovery(current, next, receipt, effectTrust, now),
  );
}
