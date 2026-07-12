export type DesiredEffect =
  | "dispatch_submit"
  | "process_start"
  | "process_stop"
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
  readonly namespaceWriterEpoch: number;
  readonly operationGateRevision: number;
  readonly openGates: ReadonlySet<string>;
  readonly ownerFence?: number;
  readonly startRevocationRevision?: number;
  readonly expectedDesiredVersion: number;
  readonly supersessionKey: string;
  readonly nodeBootEpoch?: number;
}

export function serializeMutationFence(fence: MutationFence): string {
  const fields: readonly (readonly [string, unknown])[] = [
    ["schemaVersion", fence.schemaVersion],
    ["clusterIncarnationVersion", fence.clusterIncarnationVersion],
    ["clusterIncarnation", fence.clusterIncarnation],
    ["namespaceId", fence.namespaceId],
    ["namespaceWriterEpoch", fence.namespaceWriterEpoch],
    ["operationGateRevision", fence.operationGateRevision],
    ["requiredGate", fence.requiredGate],
    ["attemptId", fence.attemptId],
    ["executionGeneration", fence.executionGeneration],
    ["allocationId", fence.allocationId ?? null],
    ["ownerFence", fence.ownerFence ?? null],
    ["desiredEffect", fence.desiredEffect],
    ["expectedDesiredVersion", fence.expectedDesiredVersion],
    ["supersessionKey", fence.supersessionKey],
    ["effectScopeKey", fence.effectScopeKey],
    ["startFence", fence.startFence ?? null],
    [
      "issuedStartRevocationRevision",
      fence.issuedStartRevocationRevision ?? null,
    ],
    ["nodeId", fence.nodeId ?? null],
    ["nodeBootEpoch", fence.nodeBootEpoch ?? null],
    ["notBefore", fence.notBefore ?? null],
    ["notAfter", fence.notAfter ?? null],
  ];
  return JSON.stringify(fields);
}

export function fingerprintMutationFence(fence: MutationFence): string {
  const value = serializeMutationFence(fence);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second + code, 0x85ebca6b);
  }
  return `fence-v1-${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function compareMutationFence(
  fence: MutationFence,
  current: FenceAuthoritySnapshot,
  now: number,
): FenceComparisonResult {
  if (
    fence.clusterIncarnationVersion !== current.clusterIncarnationVersion ||
    fence.clusterIncarnation !== current.clusterIncarnation
  )
    return "tuple_mismatch";
  if (fence.namespaceWriterEpoch < current.namespaceWriterEpoch)
    return "stale_writer";
  if (fence.namespaceWriterEpoch !== current.namespaceWriterEpoch)
    return "tuple_mismatch";
  if (
    fence.operationGateRevision < current.operationGateRevision ||
    !current.openGates.has(fence.requiredGate)
  ) {
    return "superseded_by_gate";
  }
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
    fence.issuedStartRevocationRevision !== undefined &&
    current.startRevocationRevision !== undefined &&
    fence.issuedStartRevocationRevision < current.startRevocationRevision
  )
    return "superseded_by_revocation";
  if (fence.expectedDesiredVersion < current.expectedDesiredVersion)
    return "superseded_by_desired_version";
  if (
    fence.expectedDesiredVersion !== current.expectedDesiredVersion ||
    fence.supersessionKey !== current.supersessionKey ||
    fence.nodeBootEpoch !== current.nodeBootEpoch
  )
    return "tuple_mismatch";
  if (fence.notBefore !== undefined && now < fence.notBefore)
    return "not_yet_valid";
  if (fence.notAfter !== undefined && now > fence.notAfter) return "expired";
  return "current";
}
