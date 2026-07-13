import {
  createHash,
  sign as createSignature,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";

import {
  fingerprintMutationFence,
  serializeMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export const SEAL_OUTPUT_RPC_PROTOCOL = 1 as const;

export interface SealOutputClaims {
  readonly protocolVersion: typeof SEAL_OUTPUT_RPC_PROTOCOL;
  readonly operationId: string;
  readonly issuer: string;
  readonly issuerKeyId: string;
  readonly audience: "workload-funnel-result-sealer";
  readonly nodeId: string;
  readonly nodeBootEpoch: number;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly unitInvocationDigest: string;
  readonly quiescenceReceiptDigest: string;
  readonly outputContractDigest: string;
  readonly sealProfileDigest: string;
  readonly mutationFence: MutationFence;
  readonly tupleFingerprint: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface SignedSealOutputRequest {
  readonly claims: SealOutputClaims;
  readonly signatureBase64Url: string;
}

export interface SealEntry {
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly type: "file";
}

export interface SealOutputReceipt {
  readonly protocolVersion: typeof SEAL_OUTPUT_RPC_PROTOCOL;
  readonly operationId: string;
  readonly outcome: "sealed" | "unknown" | "rejected";
  readonly authorityRegistrySequence: number;
  readonly mutationFenceFingerprint: string;
  readonly tupleFingerprint: string;
  readonly sealId?: string;
  readonly treeDigest?: string;
  readonly totalBytes?: number;
  readonly entries?: readonly SealEntry[];
  readonly reason?: string;
}

export interface SealOutputRpcRequest {
  readonly method: "seal_output";
  readonly protocolVersion: typeof SEAL_OUTPUT_RPC_PROTOCOL;
  readonly requestId: string;
  readonly authorization: SignedSealOutputRequest;
}

export interface SealOutputRpcResponse {
  readonly protocolVersion: typeof SEAL_OUTPUT_RPC_PROTOCOL;
  readonly requestId: string;
  readonly ok: boolean;
  readonly receipt?: SealOutputReceipt;
  readonly error?: Readonly<{ code: string; message: string }>;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const digest = /^[a-f0-9]{64}$/u;

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort().join("\u0000");
  if (actual !== [...expected].sort().join("\u0000")) throw new Error(code);
}

function canonicalTuple(
  claims: Omit<SealOutputClaims, "tupleFingerprint">,
): string {
  return [
    "seal-output-v1",
    claims.protocolVersion,
    claims.operationId,
    claims.issuer,
    claims.issuerKeyId,
    claims.audience,
    claims.nodeId,
    claims.nodeBootEpoch,
    claims.allocationId,
    claims.attemptId,
    claims.executionId,
    claims.executionGeneration,
    claims.unitInvocationDigest,
    claims.quiescenceReceiptDigest,
    claims.outputContractDigest,
    claims.sealProfileDigest,
    serializeMutationFence(claims.mutationFence),
    claims.issuedAtMs,
    claims.expiresAtMs,
  ]
    .map((value) => {
      const text = String(value).normalize("NFC");
      return `${String(Buffer.byteLength(text))}:${text}`;
    })
    .join("");
}

export function fingerprintSealOutputTuple(
  claims: Omit<SealOutputClaims, "tupleFingerprint">,
): string {
  return createHash("sha256").update(canonicalTuple(claims)).digest("hex");
}

export function canonicalSealOutputClaims(claims: SealOutputClaims): Buffer {
  validateSealOutputClaims(claims);
  return Buffer.from(
    `${canonicalTuple(claims)}64:${claims.tupleFingerprint}`,
    "utf8",
  );
}

export function validateSealOutputClaims(
  value: unknown,
): asserts value is SealOutputClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid_seal_output_claims");
  }
  const claims = value as unknown as SealOutputClaims;
  const untrusted = value as Readonly<Record<string, unknown>>;
  assertExactKeys(
    value as Readonly<Record<string, unknown>>,
    [
      "allocationId",
      "attemptId",
      "audience",
      "executionGeneration",
      "executionId",
      "expiresAtMs",
      "issuedAtMs",
      "issuer",
      "issuerKeyId",
      "mutationFence",
      "nodeBootEpoch",
      "nodeId",
      "operationId",
      "outputContractDigest",
      "protocolVersion",
      "quiescenceReceiptDigest",
      "sealProfileDigest",
      "tupleFingerprint",
      "unitInvocationDigest",
    ],
    "invalid_seal_output_claim_keys",
  );
  for (const field of [
    claims.operationId,
    claims.issuer,
    claims.issuerKeyId,
    claims.nodeId,
    claims.allocationId,
    claims.attemptId,
    claims.executionId,
    claims.executionGeneration,
  ]) {
    if (
      typeof field !== "string" ||
      !identifier.test(field) ||
      field !== field.normalize("NFC")
    ) {
      throw new Error("invalid_seal_output_identifier");
    }
  }
  for (const field of [
    claims.unitInvocationDigest,
    claims.quiescenceReceiptDigest,
    claims.outputContractDigest,
    claims.sealProfileDigest,
    claims.tupleFingerprint,
  ]) {
    if (typeof field !== "string" || !digest.test(field)) {
      throw new Error("invalid_seal_output_digest");
    }
  }
  if (
    untrusted["protocolVersion"] !== SEAL_OUTPUT_RPC_PROTOCOL ||
    untrusted["audience"] !== "workload-funnel-result-sealer" ||
    !Number.isSafeInteger(claims.nodeBootEpoch) ||
    claims.nodeBootEpoch < 0 ||
    !Number.isSafeInteger(claims.issuedAtMs) ||
    !Number.isSafeInteger(claims.expiresAtMs) ||
    claims.expiresAtMs <= claims.issuedAtMs
  )
    throw new Error("invalid_seal_output_authority");
  validateMutationFence(claims.mutationFence);
  const fence = claims.mutationFence;
  if (
    fence.desiredEffect !== "seal_output" ||
    fence.requiredGate !== "result_finalize" ||
    fence.startFence !== undefined ||
    fence.issuedStartRevocationRevision !== undefined ||
    fence.nodeId !== claims.nodeId ||
    fence.nodeBootEpoch !== claims.nodeBootEpoch ||
    fence.allocationId !== claims.allocationId ||
    fence.attemptId !== claims.attemptId ||
    fence.executionGeneration !== claims.executionGeneration ||
    fence.effectScopeKey !== `seal-output:${claims.executionId}` ||
    fence.supersessionKey !== fence.effectScopeKey
  )
    throw new Error("seal_output_fence_mismatch");
  const { tupleFingerprint: _tupleFingerprint, ...unsigned } = claims;
  void _tupleFingerprint;
  if (fingerprintSealOutputTuple(unsigned) !== claims.tupleFingerprint) {
    throw new Error("seal_output_tuple_fingerprint_mismatch");
  }
}

export function createSealOutputClaims(
  input: Omit<SealOutputClaims, "protocolVersion" | "tupleFingerprint">,
): SealOutputClaims {
  const unsigned = Object.freeze({
    ...input,
    protocolVersion: SEAL_OUTPUT_RPC_PROTOCOL,
  });
  const claims = Object.freeze({
    ...unsigned,
    tupleFingerprint: fingerprintSealOutputTuple(unsigned),
  });
  validateSealOutputClaims(claims);
  return claims;
}

export function signSealOutputRequest(
  claims: SealOutputClaims,
  privateKey: KeyObject,
): SignedSealOutputRequest {
  return Object.freeze({
    claims,
    signatureBase64Url: createSignature(
      null,
      canonicalSealOutputClaims(claims),
      privateKey,
    ).toString("base64url"),
  });
}

export function verifySealOutputRequest(
  request: SignedSealOutputRequest,
  trustedKeys: ReadonlyMap<string, KeyObject>,
  nowMs: number,
): SealOutputClaims {
  validateSealOutputClaims(request.claims);
  const key = trustedKeys.get(request.claims.issuerKeyId);
  if (key === undefined) throw new Error("unknown_seal_output_issuer");
  if (
    !verifySignature(
      null,
      canonicalSealOutputClaims(request.claims),
      key,
      Buffer.from(request.signatureBase64Url, "base64url"),
    )
  ) {
    throw new Error("invalid_seal_output_signature");
  }
  if (nowMs < request.claims.issuedAtMs)
    throw new Error("seal_output_not_yet_valid");
  if (nowMs >= request.claims.expiresAtMs)
    throw new Error("seal_output_expired");
  return request.claims;
}

export function sealOutputFenceFingerprint(claims: SealOutputClaims): string {
  return fingerprintMutationFence(claims.mutationFence);
}
