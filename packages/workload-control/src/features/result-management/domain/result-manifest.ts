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
  readonly complete: boolean;
  readonly retentionClass: "synthetic-ephemeral";
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

export interface ArtifactOperation {
  readonly operationId: string;
  readonly kind: "archive" | "delete";
  readonly state: "prepared" | "applied" | "unknown" | "verified_absent";
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

export function markRetentionDue(manifest: ResultManifest): ResultManifest {
  if (manifest.retentionState !== "active") {
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
  proof: "applied" | "verified_absent",
): ResultManifest {
  if (
    manifest.artifactOperation === undefined ||
    !["prepared", "unknown"].includes(manifest.artifactOperation.state)
  )
    throw new InvalidRetentionTransitionError();
  return Object.freeze({
    ...manifest,
    artifactOperation: Object.freeze({
      ...manifest.artifactOperation,
      state: proof,
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
    manifest.artifactOperation.state !== "applied"
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
