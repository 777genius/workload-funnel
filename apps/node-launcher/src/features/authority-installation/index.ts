import { createHash, sign, verify, type KeyObject } from "node:crypto";

import {
  AuthorityRegistryError,
  type AuthorityInstallAcknowledgement,
  type LauncherAuthoritySnapshot,
  type RootAuthorityRegistry,
} from "@workload-funnel/node-launcher/authority-registry";
import {
  serializeMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

export const AUTHORITY_INSTALL_SCHEMA =
  "phase4b.mutation-fence-install.v1" as const;

export type AuthorityInstallReason =
  | "cluster_rotation"
  | "writer_transfer"
  | "allocation_takeover"
  | "gate_change"
  | "attempt_revocation"
  | "desired_effect_supersession";

export interface AuthorityInstallClaims {
  readonly bootId: string;
  readonly bootEpoch: number;
  readonly effectScopeKey: string;
  readonly expiresAtMs: number;
  readonly expectedPriorFingerprint: string | null;
  readonly installOperationId: string;
  readonly issuedAtMs: number;
  readonly issuerKeyId: string;
  readonly nodeId: string;
  readonly reason: AuthorityInstallReason;
  readonly schemaVersion: typeof AUTHORITY_INSTALL_SCHEMA;
  readonly snapshot: LauncherAuthoritySnapshot;
}

export interface SignedAuthorityInstallRequest {
  readonly claims: AuthorityInstallClaims;
  readonly signatureBase64Url: string;
}

export interface SignedAuthorityInstallAcknowledgement {
  readonly acknowledgement: AuthorityInstallAcknowledgement;
  readonly launcherKeyId: string;
  readonly signatureBase64Url: string;
}

export interface AuthorityInstallerPeer {
  readonly gid: number;
  readonly pid: number;
  readonly transport: "unix";
  readonly uid: number;
}

export interface RootAuthorityInstallerConfig {
  readonly bootId: string;
  readonly bootEpoch: number;
  readonly launcherKeyId: string;
  readonly launcherPrivateKey: KeyObject;
  readonly nodeId: string;
  readonly nowMs: () => number;
  readonly registry: RootAuthorityRegistry;
  readonly trustedInstallerGid: number;
  readonly trustedInstallerKeys: ReadonlyMap<string, KeyObject>;
  readonly trustedInstallerUid: number;
}

function framed(value: string | number): string {
  const text = String(value);
  return `${String(new TextEncoder().encode(text).byteLength)}:${text}`;
}

function hasInstallSchema(value: string): boolean {
  return value === AUTHORITY_INSTALL_SCHEMA;
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\u0000") ===
    [...expected].sort().join("\u0000")
  );
}

function hasClosedSnapshot(snapshot: LauncherAuthoritySnapshot): boolean {
  const fenceKeys = [
    "allocationId",
    "attemptId",
    "clusterIncarnation",
    "clusterIncarnationVersion",
    "desiredEffect",
    "effectScopeKey",
    "executionGeneration",
    "expectedDesiredVersion",
    "namespaceId",
    "namespaceWriterEpoch",
    "nodeBootEpoch",
    "nodeId",
    "notAfter",
    "notBefore",
    "operationGateRevision",
    "ownerFence",
    "requiredGate",
    "schemaVersion",
    "supersessionKey",
    ...(snapshot.mutationFence.desiredEffect === "process_start"
      ? ["issuedStartRevocationRevision", "startFence"]
      : []),
  ];
  return (
    hasExactKeys(snapshot, [
      "allocation",
      "attempt",
      "cluster",
      "gate",
      "mutationFence",
      "mutationFenceFingerprint",
      "namespace",
    ]) &&
    hasExactKeys(snapshot.allocation, [
      "allocationId",
      "attemptId",
      "executionGeneration",
      "ownerFence",
      "ownerId",
    ]) &&
    hasExactKeys(snapshot.attempt, [
      "attemptId",
      "executionGeneration",
      "startFence",
      "startRevocationRevision",
    ]) &&
    hasExactKeys(snapshot.cluster, ["incarnationId", "version"]) &&
    hasExactKeys(snapshot.gate, ["effect", "open", "revision"]) &&
    hasExactKeys(snapshot.mutationFence, fenceKeys) &&
    hasExactKeys(snapshot.namespace, ["namespaceId", "writerEpoch", "writerId"])
  );
}

function canonicalInstallClaims(claims: AuthorityInstallClaims): Uint8Array {
  const snapshot = claims.snapshot;
  const mutationFence: MutationFence = snapshot.mutationFence;
  const values = [
    claims.schemaVersion,
    claims.installOperationId,
    claims.issuerKeyId,
    claims.nodeId,
    claims.bootId,
    claims.bootEpoch,
    claims.effectScopeKey,
    claims.expectedPriorFingerprint ?? "",
    claims.reason,
    claims.issuedAtMs,
    claims.expiresAtMs,
    snapshot.cluster.incarnationId,
    snapshot.cluster.version,
    snapshot.namespace.namespaceId,
    snapshot.namespace.writerId,
    snapshot.namespace.writerEpoch,
    snapshot.allocation.allocationId,
    snapshot.allocation.ownerId,
    snapshot.allocation.ownerFence,
    snapshot.allocation.attemptId,
    snapshot.allocation.executionGeneration,
    snapshot.attempt.attemptId,
    snapshot.attempt.executionGeneration,
    snapshot.attempt.startFence,
    snapshot.attempt.startRevocationRevision,
    snapshot.gate.effect,
    snapshot.gate.open ? "true" : "false",
    snapshot.gate.revision,
    serializeMutationFence(mutationFence),
    snapshot.mutationFenceFingerprint,
  ];
  return new TextEncoder().encode(values.map(framed).join(""));
}

function acknowledgementDigest(
  acknowledgement: AuthorityInstallAcknowledgement,
): Uint8Array {
  return createHash("sha256")
    .update(JSON.stringify(acknowledgement), "utf8")
    .digest();
}

export function signAuthorityInstallRequest(
  claims: AuthorityInstallClaims,
  privateKey: KeyObject,
): SignedAuthorityInstallRequest {
  return {
    claims,
    signatureBase64Url: sign(
      null,
      canonicalInstallClaims(claims),
      privateKey,
    ).toString("base64url"),
  };
}

export function verifyAuthorityInstallAcknowledgement(
  signed: SignedAuthorityInstallAcknowledgement,
  launcherPublicKey: KeyObject,
): boolean {
  return verify(
    null,
    acknowledgementDigest(signed.acknowledgement),
    launcherPublicKey,
    Buffer.from(signed.signatureBase64Url, "base64url"),
  );
}

export class RootAuthorityInstaller {
  public constructor(private readonly config: RootAuthorityInstallerConfig) {}

  public install(
    peer: unknown,
    request: SignedAuthorityInstallRequest,
  ): SignedAuthorityInstallAcknowledgement {
    this.assertPeer(peer);
    const claims = request.claims;
    const publicKey = this.config.trustedInstallerKeys.get(claims.issuerKeyId);
    const expectedKeys = [
      "bootId",
      "bootEpoch",
      "effectScopeKey",
      "expiresAtMs",
      "expectedPriorFingerprint",
      "installOperationId",
      "issuedAtMs",
      "issuerKeyId",
      "nodeId",
      "reason",
      "schemaVersion",
      "snapshot",
    ];
    if (
      !hasInstallSchema(claims.schemaVersion) ||
      Object.keys(claims).sort().join("\u0000") !==
        expectedKeys.sort().join("\u0000") ||
      !hasClosedSnapshot(claims.snapshot) ||
      claims.nodeId !== this.config.nodeId ||
      claims.bootId !== this.config.bootId ||
      claims.bootEpoch !== this.config.bootEpoch ||
      claims.snapshot.mutationFence.nodeId !== this.config.nodeId ||
      claims.snapshot.mutationFence.nodeBootEpoch !== this.config.bootEpoch ||
      claims.effectScopeKey !== claims.snapshot.mutationFence.effectScopeKey ||
      this.config.nowMs() < claims.issuedAtMs ||
      this.config.nowMs() >= claims.expiresAtMs ||
      publicKey === undefined ||
      !verify(
        null,
        canonicalInstallClaims(claims),
        publicKey,
        Buffer.from(request.signatureBase64Url, "base64url"),
      )
    ) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "signed complete-MutationFence install request is invalid",
      );
    }
    const acknowledgement = this.config.registry.install(
      claims.installOperationId,
      claims.snapshot,
      claims.expectedPriorFingerprint ?? undefined,
    );
    return {
      acknowledgement,
      launcherKeyId: this.config.launcherKeyId,
      signatureBase64Url: sign(
        null,
        acknowledgementDigest(acknowledgement),
        this.config.launcherPrivateKey,
      ).toString("base64url"),
    };
  }

  private assertPeer(peer: unknown): asserts peer is AuthorityInstallerPeer {
    const candidate = peer as Partial<AuthorityInstallerPeer> | null;
    if (
      candidate?.transport !== "unix" ||
      candidate.uid !== this.config.trustedInstallerUid ||
      candidate.gid !== this.config.trustedInstallerGid ||
      !validPid(candidate.pid)
    ) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "authority installation peer is not trusted",
      );
    }
  }
}
