import { createHmac, timingSafeEqual } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { TargetCanonicalAuthorityGrant } from "@workload-funnel/node-execution/process-lifecycle";

import { assertCanonicalAuthorityGrant } from "../application/runtime-dispatch-policy.js";
import type {
  SyntheticAuthority,
  SyntheticHighWatermarks,
  SyntheticRuntimeStorage,
  SyntheticVersionedIdentity,
} from "./synthetic-runtime-state.js";

const secret = Buffer.alloc(32, 0x5a);

function signaturePayload(
  grant: Omit<TargetCanonicalAuthorityGrant, "signature">,
): string {
  return JSON.stringify([
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
  ]);
}

function sign(grant: Omit<TargetCanonicalAuthorityGrant, "signature">): string {
  return createHmac("sha256", secret)
    .update(signaturePayload(grant))
    .digest("hex");
}

export function createSyntheticAuthorityGrant(
  mutationFence: MutationFence,
  changeId: string,
  targetId: string,
  expectedPriorFingerprint?: string,
): TargetCanonicalAuthorityGrant {
  if (
    mutationFence.notBefore === undefined ||
    mutationFence.notAfter === undefined
  ) {
    throw new Error("synthetic_authority_fence_validity_missing");
  }
  const unsigned = {
    audience: `subscription-runtime-broker:${targetId}`,
    changeId,
    expiresAtMs: mutationFence.notAfter,
    grantId: `${changeId}:grant`,
    issuedAtMs: mutationFence.notBefore,
    issuerId: "synthetic-canonical-authority",
    keyId: "synthetic-authority-key-v1",
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    ...(expectedPriorFingerprint === undefined
      ? {}
      : { expectedPriorFingerprint }),
    schemaVersion: "workload-funnel.runtime-authority-grant.v1" as const,
    targetId,
  };
  return Object.freeze({ ...unsigned, signature: sign(unsigned) });
}

export function verifySyntheticAuthorityGrant(
  grant: TargetCanonicalAuthorityGrant,
  targetId: string,
): void {
  assertCanonicalAuthorityGrant(grant);
  if (
    grant.targetId !== targetId ||
    grant.issuerId !== "synthetic-canonical-authority" ||
    grant.keyId !== "synthetic-authority-key-v1"
  ) {
    throw new Error("runtime_authority_grant_issuer_rejected");
  }
  const { signature, ...unsigned } = grant;
  const expected = Buffer.from(sign(unsigned), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (
    expected.byteLength !== actual.byteLength ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error("runtime_authority_grant_signature_rejected");
  }
}

function cloneHighWatermarks(
  current: SyntheticHighWatermarks,
): SyntheticHighWatermarks {
  return {
    allocations: new Map(current.allocations),
    attempts: new Map(current.attempts),
    ...(current.cluster === undefined ? {} : { cluster: current.cluster }),
    desiredScopes: new Map(current.desiredScopes),
    gates: new Map(current.gates),
    namespaces: new Map(current.namespaces),
    nodes: new Map(current.nodes),
  };
}

function advance(
  current: SyntheticVersionedIdentity | undefined,
  version: number,
  identity: string,
  field: string,
): SyntheticVersionedIdentity {
  if (current !== undefined) {
    if (version < current.version)
      throw new Error(`runtime_authority_lower_${field}`);
    if (version === current.version && identity !== current.identity) {
      throw new Error(`runtime_authority_equal_mismatch_${field}`);
    }
    if (version === current.version) return current;
  }
  return { identity, version };
}

export function nextHighWatermarks(
  current: SyntheticHighWatermarks,
  grant: TargetCanonicalAuthorityGrant,
): SyntheticHighWatermarks {
  const next = cloneHighWatermarks(current);
  const fence = grant.mutationFence;
  next.cluster = advance(
    next.cluster,
    fence.clusterIncarnationVersion,
    fence.clusterIncarnation,
    "cluster",
  );
  next.namespaces.set(
    fence.namespaceId,
    advance(
      next.namespaces.get(fence.namespaceId),
      fence.namespaceWriterEpoch,
      grant.issuerId,
      "writer",
    ),
  );
  next.gates.set(
    fence.namespaceId,
    advance(
      next.gates.get(fence.namespaceId),
      fence.operationGateRevision,
      fence.namespaceId,
      "gate",
    ),
  );
  if (fence.allocationId === undefined || fence.ownerFence === undefined) {
    throw new Error("runtime_authority_missing_owner");
  }
  next.allocations.set(
    fence.allocationId,
    advance(
      next.allocations.get(fence.allocationId),
      fence.ownerFence,
      `${fence.attemptId}\u0000${fence.executionGeneration}\u0000${fence.allocationId}`,
      "owner",
    ),
  );
  if (
    fence.startFence !== undefined &&
    fence.issuedStartRevocationRevision !== undefined
  ) {
    const key = `${fence.namespaceId}\u0000${fence.attemptId}\u0000${fence.executionGeneration}`;
    next.attempts.set(
      key,
      advance(
        next.attempts.get(key),
        fence.issuedStartRevocationRevision,
        fence.startFence,
        "revocation",
      ),
    );
  }
  next.desiredScopes.set(
    fence.effectScopeKey,
    advance(
      next.desiredScopes.get(fence.effectScopeKey),
      fence.expectedDesiredVersion,
      `${fence.desiredEffect}\u0000${fence.supersessionKey}`,
      "desired",
    ),
  );
  if (fence.nodeId === undefined || fence.nodeBootEpoch === undefined) {
    throw new Error("runtime_authority_missing_node");
  }
  next.nodes.set(
    fence.nodeId,
    advance(
      next.nodes.get(fence.nodeId),
      fence.nodeBootEpoch,
      fence.nodeId,
      "node",
    ),
  );
  return next;
}

export function applyHighWatermarks(
  storage: SyntheticRuntimeStorage,
  next: SyntheticHighWatermarks,
): void {
  if (next.cluster === undefined) {
    Reflect.deleteProperty(storage.highWatermarks, "cluster");
  } else {
    storage.highWatermarks.cluster = next.cluster;
  }
  for (const field of [
    "allocations",
    "attempts",
    "desiredScopes",
    "gates",
    "namespaces",
    "nodes",
  ] as const) {
    storage.highWatermarks[field].clear();
    for (const [key, value] of next[field]) {
      storage.highWatermarks[field].set(key, value);
    }
  }
}

function requireCurrent(
  current: SyntheticVersionedIdentity | undefined,
  version: number | undefined,
  identity: string | undefined,
  field: string,
): void {
  if (
    current === undefined ||
    version === undefined ||
    identity === undefined
  ) {
    throw new Error(`runtime_final_mutator_missing_${field}`);
  }
  if (version < current.version)
    throw new Error(`runtime_final_mutator_lower_${field}`);
  if (version !== current.version || identity !== current.identity) {
    throw new Error(`runtime_final_mutator_equal_mismatch_${field}`);
  }
}

export function assertCurrentHighWatermarks(
  highWatermarks: SyntheticHighWatermarks,
  fence: MutationFence,
  issuerId: string,
): void {
  requireCurrent(
    highWatermarks.cluster,
    fence.clusterIncarnationVersion,
    fence.clusterIncarnation,
    "cluster",
  );
  requireCurrent(
    highWatermarks.namespaces.get(fence.namespaceId),
    fence.namespaceWriterEpoch,
    issuerId,
    "writer",
  );
  requireCurrent(
    highWatermarks.gates.get(fence.namespaceId),
    fence.operationGateRevision,
    fence.namespaceId,
    "gate",
  );
  requireCurrent(
    fence.allocationId === undefined
      ? undefined
      : highWatermarks.allocations.get(fence.allocationId),
    fence.ownerFence,
    fence.allocationId === undefined
      ? undefined
      : `${fence.attemptId}\u0000${fence.executionGeneration}\u0000${fence.allocationId}`,
    "owner",
  );
  if (fence.startFence !== undefined) {
    requireCurrent(
      highWatermarks.attempts.get(
        `${fence.namespaceId}\u0000${fence.attemptId}\u0000${fence.executionGeneration}`,
      ),
      fence.issuedStartRevocationRevision,
      fence.startFence,
      "revocation",
    );
  }
  requireCurrent(
    highWatermarks.desiredScopes.get(fence.effectScopeKey),
    fence.expectedDesiredVersion,
    `${fence.desiredEffect}\u0000${fence.supersessionKey}`,
    "desired",
  );
  requireCurrent(
    fence.nodeId === undefined
      ? undefined
      : highWatermarks.nodes.get(fence.nodeId),
    fence.nodeBootEpoch,
    fence.nodeId,
    "node",
  );
}

function compareVersion(
  prior: number | undefined,
  next: number | undefined,
  identityMatches: boolean,
  field: string,
): boolean {
  if (prior === undefined || next === undefined) {
    if (prior !== next) throw new Error(`runtime_authority_missing_${field}`);
    return false;
  }
  if (next < prior) throw new Error(`runtime_authority_lower_${field}`);
  if (next === prior && !identityMatches) {
    throw new Error(`runtime_authority_equal_mismatch_${field}`);
  }
  return next > prior;
}

export function compareScopeForAdvance(
  current: SyntheticAuthority,
  grant: TargetCanonicalAuthorityGrant,
): void {
  const prior = current.fence;
  const next = grant.mutationFence;
  if (
    next.effectScopeKey !== prior.effectScopeKey ||
    next.namespaceId !== prior.namespaceId ||
    next.attemptId !== prior.attemptId ||
    next.executionGeneration !== prior.executionGeneration ||
    next.allocationId !== prior.allocationId
  ) {
    throw new Error("runtime_authority_immutable_scope_mismatch");
  }
  const advanced = [
    compareVersion(
      prior.clusterIncarnationVersion,
      next.clusterIncarnationVersion,
      prior.clusterIncarnation === next.clusterIncarnation,
      "cluster",
    ),
    compareVersion(
      prior.namespaceWriterEpoch,
      next.namespaceWriterEpoch,
      current.issuerId === grant.issuerId,
      "writer",
    ),
    compareVersion(
      prior.ownerFence,
      next.ownerFence,
      prior.allocationId === next.allocationId,
      "owner",
    ),
    compareVersion(
      prior.operationGateRevision,
      next.operationGateRevision,
      prior.requiredGate === next.requiredGate,
      "gate",
    ),
    compareVersion(
      prior.issuedStartRevocationRevision,
      next.issuedStartRevocationRevision,
      prior.startFence === next.startFence,
      "revocation",
    ),
    compareVersion(
      prior.expectedDesiredVersion,
      next.expectedDesiredVersion,
      prior.desiredEffect === next.desiredEffect &&
        prior.supersessionKey === next.supersessionKey,
      "desired",
    ),
    compareVersion(
      prior.nodeBootEpoch,
      next.nodeBootEpoch,
      prior.nodeId === next.nodeId,
      "node",
    ),
  ].some(Boolean);
  if (!advanced && grant.mutationFenceFingerprint !== current.fingerprint) {
    throw new Error("runtime_authority_equal_tuple_mismatch");
  }
}
