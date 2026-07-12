export type DesiredEffect =
  | "dispatch_submit"
  | "dispatch_cancel"
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

function numberAt(values: ArrayLike<number>, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error("sha256_index_out_of_bounds");
  return value;
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

function rotateRight(value: number, places: number): number {
  return (value >>> places) | (value << (32 - places));
}

function sha256Hex(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) {
    bytes.push(shift >= 32 ? 0 : (bitLength >>> shift) & 0xff);
  }
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64).fill(0);
    for (let index = 0; index < 16; index += 1) {
      const position = offset + index * 4;
      words[index] =
        ((numberAt(bytes, position) << 24) |
          (numberAt(bytes, position + 1) << 16) |
          (numberAt(bytes, position + 2) << 8) |
          numberAt(bytes, position + 3)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = numberAt(words, index - 15);
      const earlier = numberAt(words, index - 2);
      const small0 =
        rotateRight(previous, 7) ^ rotateRight(previous, 18) ^ (previous >>> 3);
      const small1 =
        rotateRight(earlier, 17) ^ rotateRight(earlier, 19) ^ (earlier >>> 10);
      words[index] =
        (numberAt(words, index - 16) +
          small0 +
          numberAt(words, index - 7) +
          small1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h +
          sum1 +
          choice +
          numberAt(constants, index) +
          numberAt(words, index)) >>>
        0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) {
      hash[index] = (numberAt(hash, index) + numberAt(next, index)) >>> 0;
    }
  }
  return hash.map((word) => word.toString(16).padStart(8, "0")).join("");
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
