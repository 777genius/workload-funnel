import {
  sign as signBytes,
  timingSafeEqual,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";

import {
  fingerprintMutationFence,
  serializeMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { TargetCanonicalAuthorityGrant } from "@workload-funnel/node-execution/process-lifecycle";

function payload(
  grant: Omit<TargetCanonicalAuthorityGrant, "signature">,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      grant.schemaVersion,
      grant.grantId,
      grant.issuerId,
      grant.keyId,
      grant.audience,
      grant.targetId,
      grant.changeId,
      grant.issuedAtMs,
      grant.expiresAtMs,
      grant.expectedPriorFingerprint ?? null,
      grant.mutationFenceFingerprint,
      serializeMutationFence(grant.mutationFence),
    ]),
    "utf8",
  );
}

export function signRuntimeAuthorityGrant(
  mutationFence: MutationFence,
  changeId: string,
  targetId: string,
  privateKey: KeyObject,
): TargetCanonicalAuthorityGrant {
  validateMutationFence(mutationFence);
  if (
    mutationFence.notBefore === undefined ||
    mutationFence.notAfter === undefined
  ) {
    throw new Error("runtime_authority_validity_missing");
  }
  const unsigned = Object.freeze({
    audience: `subscription-runtime-broker:${targetId}`,
    changeId,
    expiresAtMs: mutationFence.notAfter,
    grantId: `${changeId}:grant`,
    issuedAtMs: mutationFence.notBefore,
    issuerId: "full-lifecycle-control",
    keyId: "full-lifecycle-runtime-authority",
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    schemaVersion: "workload-funnel.runtime-authority-grant.v1" as const,
    targetId,
  });
  return Object.freeze({
    ...unsigned,
    signature: signBytes(null, payload(unsigned), privateKey).toString(
      "base64url",
    ),
  });
}

export function verifyRuntimeAuthorityGrant(
  grant: TargetCanonicalAuthorityGrant,
  targetId: string,
  trustedKeys: ReadonlyMap<string, KeyObject>,
  nowMs: number,
): void {
  validateMutationFence(grant.mutationFence);
  const fingerprint = fingerprintMutationFence(grant.mutationFence);
  const fingerprintBytes = Buffer.from(fingerprint, "utf8");
  const claimedFingerprint = Buffer.from(
    grant.mutationFenceFingerprint,
    "utf8",
  );
  const publicKey = trustedKeys.get(grant.keyId);
  const { signature, ...unsigned } = grant;
  if (
    publicKey === undefined ||
    grant.issuerId !== "full-lifecycle-control" ||
    grant.targetId !== targetId ||
    grant.audience !== `subscription-runtime-broker:${targetId}` ||
    grant.issuedAtMs > nowMs ||
    grant.expiresAtMs < nowMs ||
    fingerprintBytes.byteLength !== claimedFingerprint.byteLength ||
    !timingSafeEqual(fingerprintBytes, claimedFingerprint) ||
    !verifyBytes(
      null,
      payload(unsigned),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
  ) {
    throw new Error("runtime_authority_signature_rejected");
  }
}
