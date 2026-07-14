import {
  fingerprintMutationFence,
  sha256Hex,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export interface ResultEntry {
  readonly path: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly location: string;
}

export interface ResultManifest {
  readonly resultManifestId: string;
  readonly attemptId: string;
  readonly executionId?: string;
  readonly entries: readonly ResultEntry[];
  readonly artifactProviderId?: string;
  readonly complete: boolean;
  readonly publicationState?: "staged" | "complete" | "failed";
  readonly immutableStagingIdentity?: string;
  readonly manifestDigest?: string;
  readonly stagingMutationFence?: MutationFence;
  readonly stagingMutationFenceFingerprint?: string;
  readonly stagingOperationId?: string;
  readonly stagingReceiptBindingDigest?: string;
  readonly verificationReceiptId?: string;
  readonly retentionClass: "synthetic-ephemeral" | "standard";
  readonly retentionExpiresAt?: number;
  readonly retentionState:
    | "active"
    | "retention_due"
    | "archiving"
    | "archived"
    | "deleting"
    | "tombstoned";
  readonly tombstone?: ResultTombstone;
  readonly artifactOperation?: ArtifactOperation;
  readonly version: number;
}

export interface ResultTombstone {
  readonly reason: string;
  readonly actorId: string;
  readonly policyRevision: number;
  readonly deletedAt: number;
  readonly entryDigests: readonly string[];
}

export interface ResultStagingEvidence {
  readonly resultManifestId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly stagingOperationId: string;
  readonly stagingReceiptBindingDigest: string;
  readonly entries: readonly ResultEntry[];
  readonly artifactProviderId: string;
  readonly retentionClass: ResultManifest["retentionClass"];
  readonly retentionExpiresAt: number;
}

export function resultStagingReceiptBinding(
  evidence: Pick<
    ResultStagingEvidence,
    | "entries"
    | "immutableStagingIdentity"
    | "manifestDigest"
    | "mutationFenceFingerprint"
    | "stagingOperationId"
    | "artifactProviderId"
  >,
): string {
  const entries = [...evidence.entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return `artifact-stage-v1-${sha256Hex(
    JSON.stringify({
      artifactProviderId: evidence.artifactProviderId,
      entries,
      immutableStagingIdentity: evidence.immutableStagingIdentity,
      manifestDigest: evidence.manifestDigest,
      mutationFenceFingerprint: evidence.mutationFenceFingerprint,
      operationId: evidence.stagingOperationId,
    }),
  )}`;
}

export interface ResultVerificationEvidence {
  readonly operationId: string;
  readonly resultManifestId: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly verifiedEntries: readonly ResultEntry[];
  readonly status: "verified";
  readonly providerId: string;
}

export interface ArtifactOperation {
  readonly operationId: string;
  readonly kind: "archive" | "delete";
  readonly state:
    | "prepared"
    | "applied"
    | "unknown"
    | "retryable"
    | "verified_absent";
  readonly stagingIdentity: string;
}

export class IncompleteResultManifestError extends Error {
  public constructor() {
    super("Attempt success requires a complete ResultManifest");
    this.name = "IncompleteResultManifestError";
  }
}

export class InvalidRetentionTransitionError extends Error {
  public constructor() {
    super("invalid_retention_transition");
    this.name = "InvalidRetentionTransitionError";
  }
}

function sameEntries(
  left: readonly ResultEntry[],
  right: readonly ResultEntry[],
): boolean {
  const normalize = (entries: readonly ResultEntry[]) =>
    [...entries].map((entry) => JSON.stringify(entry)).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function stageResultManifest(
  evidence: ResultStagingEvidence,
): ResultManifest {
  validateMutationFence(evidence.mutationFence);
  if (
    !/^[a-f0-9]{64}$/u.test(evidence.manifestDigest) ||
    evidence.artifactProviderId.length === 0 ||
    evidence.immutableStagingIdentity.length === 0 ||
    !Number.isSafeInteger(evidence.retentionExpiresAt) ||
    evidence.retentionExpiresAt < 0 ||
    evidence.mutationFence.desiredEffect !== "artifact_stage" ||
    evidence.mutationFence.requiredGate !== "result_finalize" ||
    evidence.mutationFence.attemptId !== evidence.attemptId ||
    evidence.mutationFence.effectScopeKey !==
      `artifact-stage:${evidence.executionId}` ||
    evidence.mutationFenceFingerprint !==
      fingerprintMutationFence(evidence.mutationFence) ||
    evidence.stagingOperationId.length === 0 ||
    !/^artifact-stage-v1-[a-f0-9]{64}$/u.test(
      evidence.stagingReceiptBindingDigest,
    ) ||
    evidence.stagingReceiptBindingDigest !==
      resultStagingReceiptBinding(evidence) ||
    !evidence.immutableStagingIdentity.includes(
      Buffer.from(evidence.mutationFenceFingerprint).toString("base64url"),
    )
  )
    throw new Error("invalid_result_staging_evidence");
  return Object.freeze({
    artifactProviderId: evidence.artifactProviderId,
    attemptId: evidence.attemptId,
    complete: false,
    entries: Object.freeze([...evidence.entries]),
    executionId: evidence.executionId,
    immutableStagingIdentity: evidence.immutableStagingIdentity,
    manifestDigest: evidence.manifestDigest,
    publicationState: "staged",
    resultManifestId: evidence.resultManifestId,
    retentionClass: evidence.retentionClass,
    retentionExpiresAt: evidence.retentionExpiresAt,
    retentionState: "active",
    stagingMutationFence: evidence.mutationFence,
    stagingMutationFenceFingerprint: evidence.mutationFenceFingerprint,
    stagingOperationId: evidence.stagingOperationId,
    stagingReceiptBindingDigest: evidence.stagingReceiptBindingDigest,
    version: 1,
  });
}

export function validatePersistedStagingEvidence(
  manifest: ResultManifest,
): void {
  const fence = manifest.stagingMutationFence;
  const fingerprint = manifest.stagingMutationFenceFingerprint;
  const operationId = manifest.stagingOperationId;
  const binding = manifest.stagingReceiptBindingDigest;
  const identity = manifest.immutableStagingIdentity;
  const manifestDigest = manifest.manifestDigest;
  const artifactProviderId = manifest.artifactProviderId;
  if (
    fence === undefined ||
    fingerprint === undefined ||
    operationId === undefined ||
    binding === undefined ||
    identity === undefined ||
    manifestDigest === undefined ||
    artifactProviderId === undefined
  )
    throw new Error("result_staging_evidence_missing");
  validateMutationFence(fence);
  if (
    fingerprint !== fingerprintMutationFence(fence) ||
    fence.desiredEffect !== "artifact_stage" ||
    fence.attemptId !== manifest.attemptId ||
    fence.effectScopeKey !== `artifact-stage:${manifest.executionId ?? ""}` ||
    !identity.includes(Buffer.from(fingerprint).toString("base64url")) ||
    binding !==
      resultStagingReceiptBinding({
        artifactProviderId,
        entries: manifest.entries,
        immutableStagingIdentity: identity,
        manifestDigest,
        mutationFenceFingerprint: fingerprint,
        stagingOperationId: operationId,
      })
  )
    throw new Error("result_staging_evidence_mismatch");
}

export function finalizeResultManifest(
  manifest: ResultManifest,
  verification: ResultVerificationEvidence,
): ResultManifest {
  if (
    manifest.publicationState !== "staged" ||
    manifest.complete ||
    verification.resultManifestId !== manifest.resultManifestId ||
    verification.immutableStagingIdentity !==
      manifest.immutableStagingIdentity ||
    verification.manifestDigest !== manifest.manifestDigest ||
    verification.providerId !== manifest.artifactProviderId ||
    !sameEntries(verification.verifiedEntries, manifest.entries)
  )
    throw new Error("result_verification_receipt_mismatch");
  return Object.freeze({
    ...manifest,
    complete: true,
    publicationState: "complete",
    verificationReceiptId: verification.operationId,
    version: manifest.version + 1,
  });
}

export function markRetentionDue(manifest: ResultManifest): ResultManifest {
  if (manifest.retentionState !== "active" || !manifest.complete) {
    throw new InvalidRetentionTransitionError();
  }
  return Object.freeze({
    ...manifest,
    retentionState: "retention_due",
    version: manifest.version + 1,
  });
}

export function prepareArtifactOperation(
  manifest: ResultManifest,
  operationId: string,
  kind: ArtifactOperation["kind"],
): ResultManifest {
  const prior = manifest.artifactOperation;
  if (prior !== undefined) {
    if (prior.operationId !== operationId || prior.kind !== kind) {
      throw new Error("artifact_operation_conflict");
    }
    return manifest;
  }
  if (manifest.retentionState !== "retention_due") {
    throw new InvalidRetentionTransitionError();
  }
  return Object.freeze({
    ...manifest,
    artifactOperation: Object.freeze({
      kind,
      operationId,
      stagingIdentity: `artifact-operation:${manifest.resultManifestId}:${operationId}`,
      state: "prepared",
    }),
    retentionState: kind === "archive" ? "archiving" : "deleting",
    version: manifest.version + 1,
  });
}

export function markArtifactOperationUnknown(
  manifest: ResultManifest,
): ResultManifest {
  if (manifest.artifactOperation?.state === "unknown") return manifest;
  if (manifest.artifactOperation?.state !== "prepared") {
    throw new InvalidRetentionTransitionError();
  }
  return Object.freeze({
    ...manifest,
    artifactOperation: Object.freeze({
      ...manifest.artifactOperation,
      state: "unknown",
    }),
    version: manifest.version + 1,
  });
}

export function reconcileArtifactOperation(
  manifest: ResultManifest,
  proof: "applied" | "verified_absent" | "still_present",
): ResultManifest {
  if (
    manifest.artifactOperation === undefined ||
    !["prepared", "unknown", "applied"].includes(
      manifest.artifactOperation.state,
    )
  )
    throw new InvalidRetentionTransitionError();
  return Object.freeze({
    ...manifest,
    artifactOperation: Object.freeze({
      ...manifest.artifactOperation,
      state: proof === "still_present" ? "retryable" : proof,
    }),
    version: manifest.version + 1,
  });
}

export function tombstoneResult(
  manifest: ResultManifest,
  tombstone: ResultTombstone,
): ResultManifest {
  if (
    manifest.retentionState !== "deleting" ||
    manifest.artifactOperation?.kind !== "delete" ||
    manifest.artifactOperation.state !== "verified_absent"
  )
    throw new InvalidRetentionTransitionError();
  return Object.freeze({
    ...manifest,
    retentionState: "tombstoned",
    tombstone: Object.freeze({
      ...tombstone,
      entryDigests: Object.freeze([...tombstone.entryDigests]),
    }),
    version: manifest.version + 1,
  });
}
