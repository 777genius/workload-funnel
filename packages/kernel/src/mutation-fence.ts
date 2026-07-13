import { sha256Hex } from "./canonical-digest.js";

export type DesiredEffect =
  | "dispatch_submit"
  | "dispatch_cancel"
  | "process_start"
  | "process_stop"
  | "seal_output"
  | "artifact_stage"
  | "artifact_finalize"
  | "artifact_delete";

export interface MutationFence {
  readonly schemaVersion: 1;
  readonly clusterIncarnationVersion: number;
  readonly clusterIncarnation: string;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly operationGateRevision: number;
  readonly requiredGate: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly allocationId?: string;
  readonly ownerFence?: number;
  readonly desiredEffect: DesiredEffect;
  readonly expectedDesiredVersion: number;
  readonly supersessionKey: string;
  readonly effectScopeKey: string;
  readonly startFence?: string;
  readonly issuedStartRevocationRevision?: number;
  readonly nodeId?: string;
  readonly nodeBootEpoch?: number;
  readonly notBefore?: number;
  readonly notAfter?: number;
}

export type FenceComparisonResult =
  | "current"
  | "stale_writer"
  | "stale_owner"
  | "superseded_by_gate"
  | "superseded_by_revocation"
  | "superseded_by_desired_version"
  | "not_yet_valid"
  | "expired"
  | "tuple_mismatch";

export interface FenceAuthoritySnapshot {
  readonly clusterIncarnationVersion: number;
  readonly clusterIncarnation: string;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly operationGateRevision: number;
  readonly requiredGate: string;
  readonly openGates: ReadonlySet<string>;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly allocationId?: string;
  readonly ownerFence?: number;
  readonly startFence?: string;
  readonly startRevocationRevision?: number;
  readonly desiredEffect: DesiredEffect;
  readonly expectedDesiredVersion: number;
  readonly supersessionKey: string;
  readonly effectScopeKey: string;
  readonly nodeId?: string;
  readonly nodeBootEpoch?: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function assertRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid_mutation_fence_${field}`);
  }
}

function assertIdentifier(value: string, field: string): void {
  if (!identifierPattern.test(value) || value !== value.normalize("NFC")) {
    throw new Error(`invalid_mutation_fence_${field}`);
  }
}

function assertSchemaVersion(value: number): void {
  if (value !== 1) throw new Error("unsupported_mutation_fence");
}

export function validateMutationFence(fence: MutationFence): void {
  assertSchemaVersion(fence.schemaVersion);
  for (const [field, value] of [
    ["cluster_incarnation_version", fence.clusterIncarnationVersion],
    ["namespace_writer_epoch", fence.namespaceWriterEpoch],
    ["operation_gate_revision", fence.operationGateRevision],
    ["expected_desired_version", fence.expectedDesiredVersion],
  ] as const) {
    assertRevision(value, field);
  }
  for (const [field, value] of [
    ["cluster_incarnation", fence.clusterIncarnation],
    ["namespace_id", fence.namespaceId],
    ["required_gate", fence.requiredGate],
    ["attempt_id", fence.attemptId],
    ["execution_generation", fence.executionGeneration],
    ["supersession_key", fence.supersessionKey],
    ["effect_scope_key", fence.effectScopeKey],
  ] as const) {
    assertIdentifier(value, field);
  }
  if ((fence.allocationId === undefined) !== (fence.ownerFence === undefined)) {
    throw new Error("invalid_mutation_fence_allocation_authority");
  }
  if (fence.allocationId !== undefined) {
    assertIdentifier(fence.allocationId, "allocation_id");
    const ownerFence = fence.ownerFence;
    if (ownerFence === undefined) {
      throw new Error("invalid_mutation_fence_allocation_authority");
    }
    assertRevision(ownerFence, "owner_fence");
  }
  const startApplicable = ["dispatch_submit", "process_start"].includes(
    fence.desiredEffect,
  );
  if (
    startApplicable !==
    (fence.startFence !== undefined &&
      fence.issuedStartRevocationRevision !== undefined)
  ) {
    throw new Error("invalid_mutation_fence_start_authority");
  }
  if (fence.startFence !== undefined) {
    assertIdentifier(fence.startFence, "start_fence");
    const startRevision = fence.issuedStartRevocationRevision;
    if (startRevision === undefined) {
      throw new Error("invalid_mutation_fence_start_authority");
    }
    assertRevision(startRevision, "start_revocation_revision");
  }
  if ((fence.nodeId === undefined) !== (fence.nodeBootEpoch === undefined)) {
    throw new Error("invalid_mutation_fence_node_authority");
  }
  if (fence.nodeId !== undefined) {
    assertIdentifier(fence.nodeId, "node_id");
    const nodeBootEpoch = fence.nodeBootEpoch;
    if (nodeBootEpoch === undefined) {
      throw new Error("invalid_mutation_fence_node_authority");
    }
    assertRevision(nodeBootEpoch, "node_boot_epoch");
  }
  if (fence.notBefore !== undefined)
    assertRevision(fence.notBefore, "not_before");
  if (fence.notAfter !== undefined) assertRevision(fence.notAfter, "not_after");
  if (
    fence.notBefore !== undefined &&
    fence.notAfter !== undefined &&
    fence.notAfter <= fence.notBefore
  ) {
    throw new Error("invalid_mutation_fence_validity_window");
  }
}

function lengthDelimited(value: string | number | null): string {
  if (value === null) return "0:";
  const text = String(value).normalize("NFC");
  return `${String(new TextEncoder().encode(text).byteLength)}:${text}`;
}

export function serializeMutationFence(fence: MutationFence): string {
  validateMutationFence(fence);
  const values: readonly (string | number | null)[] = [
    fence.schemaVersion,
    fence.clusterIncarnationVersion,
    fence.clusterIncarnation,
    fence.namespaceId,
    fence.namespaceWriterEpoch,
    fence.operationGateRevision,
    fence.requiredGate,
    fence.attemptId,
    fence.executionGeneration,
    fence.allocationId ?? null,
    fence.ownerFence ?? null,
    fence.desiredEffect,
    fence.expectedDesiredVersion,
    fence.supersessionKey,
    fence.effectScopeKey,
    fence.startFence ?? null,
    fence.issuedStartRevocationRevision ?? null,
    fence.nodeId ?? null,
    fence.nodeBootEpoch ?? null,
    fence.notBefore ?? null,
    fence.notAfter ?? null,
  ];
  const presenceBits = values
    .map((value) => (value === null ? "0" : "1"))
    .join("");
  return `mutation-fence-v1${presenceBits}${values.map(lengthDelimited).join("")}`;
}

export function fingerprintMutationFence(fence: MutationFence): string {
  return `fence-v1-${sha256Hex(serializeMutationFence(fence))}`;
}

export function compareMutationFence(
  fence: MutationFence,
  current: FenceAuthoritySnapshot,
  now: number,
): FenceComparisonResult {
  try {
    validateMutationFence(fence);
  } catch {
    return "tuple_mismatch";
  }
  if (
    fence.clusterIncarnationVersion !== current.clusterIncarnationVersion ||
    fence.clusterIncarnation !== current.clusterIncarnation ||
    fence.namespaceId !== current.namespaceId
  )
    return "tuple_mismatch";
  if (fence.namespaceWriterEpoch < current.namespaceWriterEpoch)
    return "stale_writer";
  if (fence.namespaceWriterEpoch !== current.namespaceWriterEpoch)
    return "tuple_mismatch";
  if (
    fence.operationGateRevision < current.operationGateRevision ||
    fence.requiredGate !== current.requiredGate ||
    !current.openGates.has(fence.requiredGate)
  )
    return "superseded_by_gate";
  if (fence.operationGateRevision !== current.operationGateRevision)
    return "tuple_mismatch";
  if (fence.ownerFence !== current.ownerFence) {
    return fence.ownerFence !== undefined &&
      current.ownerFence !== undefined &&
      fence.ownerFence < current.ownerFence
      ? "stale_owner"
      : "tuple_mismatch";
  }
  if (
    fence.attemptId !== current.attemptId ||
    fence.executionGeneration !== current.executionGeneration ||
    fence.allocationId !== current.allocationId
  )
    return "tuple_mismatch";
  if (fence.startFence !== undefined) {
    if (fence.startFence !== current.startFence) return "tuple_mismatch";
    if (
      fence.issuedStartRevocationRevision !== undefined &&
      current.startRevocationRevision !== undefined &&
      fence.issuedStartRevocationRevision < current.startRevocationRevision
    )
      return "superseded_by_revocation";
    if (fence.issuedStartRevocationRevision !== current.startRevocationRevision)
      return "tuple_mismatch";
  }
  if (fence.expectedDesiredVersion < current.expectedDesiredVersion)
    return "superseded_by_desired_version";
  if (
    fence.expectedDesiredVersion !== current.expectedDesiredVersion ||
    fence.desiredEffect !== current.desiredEffect ||
    fence.supersessionKey !== current.supersessionKey ||
    fence.effectScopeKey !== current.effectScopeKey ||
    fence.nodeId !== current.nodeId ||
    fence.nodeBootEpoch !== current.nodeBootEpoch
  )
    return "tuple_mismatch";
  if (fence.notBefore !== undefined && now < fence.notBefore)
    return "not_yet_valid";
  if (fence.notAfter !== undefined && now >= fence.notAfter) return "expired";
  return "current";
}
