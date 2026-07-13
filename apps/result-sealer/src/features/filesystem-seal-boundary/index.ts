import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  SealEntry,
  SealOutputReceipt,
  SealOutputRpcRequest,
  SealOutputRpcResponse,
  SignedSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";
import type {
  PinnedFilesystemIdentity,
  SealAuthorityRegistry,
  SealPreparedEvidence,
} from "@workload-funnel/result-sealer/seal-authority-registry";

export const REQUIRED_DESCRIPTOR_RESOLUTION = Object.freeze([
  "RESOLVE_BENEATH",
  "RESOLVE_NO_SYMLINKS",
  "RESOLVE_NO_MAGICLINKS",
  "RESOLVE_NO_XDEV",
] as const);

export interface DescriptorTreeEntry {
  readonly pathSegments: readonly string[];
  readonly type:
    | "directory"
    | "file"
    | "symlink"
    | "fifo"
    | "socket"
    | "device";
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
  readonly sizeBytes: number;
  readonly allocatedBytes: number;
  readonly changeToken: string;
  readonly digest?: string;
  readonly xattrs: readonly string[];
}

export interface DescriptorTreeSnapshot {
  readonly entries: readonly DescriptorTreeEntry[];
}

export interface DescriptorSealFilesystem {
  readonly outputParent: PinnedFilesystemIdentity;
  readonly stagingParent: PinnedFilesystemIdentity;
  scanSource(sourceName: string): DescriptorTreeSnapshot;
  atomicSeal(
    input: Readonly<{
      sourceName: string;
      destinationName: string;
      expectedSource: DescriptorTreeSnapshot;
    }>,
  ): DescriptorTreeSnapshot;
}

export interface SealLimits {
  readonly maxDepth: number;
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface FilesystemSealBoundaryConfig {
  readonly filesystem: DescriptorSealFilesystem;
  readonly registry: SealAuthorityRegistry;
  readonly expectedOutputParent: PinnedFilesystemIdentity;
  readonly expectedStagingParent: PinnedFilesystemIdentity;
  readonly expectedWorkloadUid: number;
  readonly limits: SealLimits;
}

export class UnsafeSealTreeError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "UnsafeSealTreeError";
  }
}

function encodeIdentitySegment(value: string | number): string {
  return Buffer.from(String(value).normalize("NFC"), "utf8").toString(
    "base64url",
  );
}

export function deterministicOutputName(
  input: Readonly<{
    nodeId: string;
    allocationId: string;
    executionGeneration: string;
  }>,
): string {
  return [input.nodeId, input.allocationId, input.executionGeneration]
    .map(encodeIdentitySegment)
    .join("--");
}

function samePin(
  left: PinnedFilesystemIdentity,
  right: PinnedFilesystemIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function entryKey(entry: DescriptorTreeEntry): string {
  return entry.pathSegments.join("/");
}

function stableEntry(entry: DescriptorTreeEntry): string {
  return JSON.stringify({
    allocatedBytes: entry.allocatedBytes,
    changeToken: entry.changeToken,
    device: entry.device,
    digest: entry.digest ?? null,
    inode: entry.inode,
    mode: entry.mode,
    nlink: entry.nlink,
    pathSegments: entry.pathSegments,
    sizeBytes: entry.sizeBytes,
    type: entry.type,
    uid: entry.uid,
    xattrs: [...entry.xattrs].sort(),
  });
}

function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\u0000") ||
    segment !== segment.normalize("NFC")
  )
    throw new UnsafeSealTreeError("unsafe_result_path_segment");
}

function validateSnapshot(
  snapshot: DescriptorTreeSnapshot,
  config: FilesystemSealBoundaryConfig,
): Readonly<{
  entries: readonly SealEntry[];
  totalBytes: number;
  treeDigest: string;
}> {
  if (snapshot.entries.length > config.limits.maxEntries)
    throw new UnsafeSealTreeError("result_entry_limit_exceeded");
  const keys = new Set<string>();
  let totalBytes = 0;
  const files: SealEntry[] = [];
  const stable: string[] = [];
  for (const entry of snapshot.entries) {
    for (const segment of entry.pathSegments) assertSafeSegment(segment);
    if (
      entry.pathSegments.length === 0 ||
      entry.pathSegments.length > config.limits.maxDepth
    ) {
      throw new UnsafeSealTreeError("result_depth_limit_exceeded");
    }
    const key = entryKey(entry);
    if (keys.has(key)) throw new UnsafeSealTreeError("duplicate_result_entry");
    keys.add(key);
    if (
      !Number.isSafeInteger(entry.uid) ||
      entry.uid !== config.expectedWorkloadUid ||
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes < 0 ||
      !Number.isSafeInteger(entry.allocatedBytes) ||
      entry.allocatedBytes < 0 ||
      entry.device !== config.filesystem.outputParent.device ||
      (entry.mode & 0o6000) !== 0 ||
      entry.xattrs.length !== 0
    )
      throw new UnsafeSealTreeError("unsafe_result_metadata");
    if (entry.type !== "file" && entry.type !== "directory")
      throw new UnsafeSealTreeError("special_result_file_refused");
    if (entry.type === "file") {
      if (
        entry.nlink !== 1 ||
        entry.digest === undefined ||
        !/^[a-f0-9]{64}$/u.test(entry.digest) ||
        entry.sizeBytes > config.limits.maxFileBytes ||
        entry.allocatedBytes < entry.sizeBytes
      )
        throw new UnsafeSealTreeError("unsafe_result_regular_file");
      totalBytes += entry.sizeBytes;
      if (
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > config.limits.maxTotalBytes
      ) {
        throw new UnsafeSealTreeError("result_byte_limit_exceeded");
      }
      files.push(
        Object.freeze({
          digest: entry.digest,
          path: key,
          sizeBytes: entry.sizeBytes,
          type: "file",
        }),
      );
    }
    stable.push(stableEntry(entry));
  }
  stable.sort();
  files.sort((left, right) =>
    Buffer.from(left.path).compare(Buffer.from(right.path)),
  );
  const treeDigest = createHash("sha256")
    .update(JSON.stringify(stable), "utf8")
    .digest("hex");
  return Object.freeze({
    entries: Object.freeze(files),
    totalBytes,
    treeDigest,
  });
}

function assertUnchanged(
  before: DescriptorTreeSnapshot,
  after: DescriptorTreeSnapshot,
): void {
  const left = [...before.entries].map(stableEntry).sort();
  const right = [...after.entries].map(stableEntry).sort();
  if (JSON.stringify(left) !== JSON.stringify(right))
    throw new UnsafeSealTreeError("result_mutation_race");
}

export class FilesystemSealBoundary {
  public constructor(private readonly config: FilesystemSealBoundaryConfig) {
    if (
      !samePin(config.filesystem.outputParent, config.expectedOutputParent) ||
      !samePin(config.filesystem.stagingParent, config.expectedStagingParent) ||
      config.filesystem.outputParent.device !==
        config.filesystem.stagingParent.device
    )
      throw new UnsafeSealTreeError("descriptor_sealing_profile_unsupported");
  }

  public seal(authorization: SignedSealOutputRequest): SealOutputReceipt {
    const authorized = this.config.registry.authorize(authorization);
    const { claims, registrySequence } = authorized;
    const prior = this.config.registry.state(claims.operationId);
    if (prior?.state === "receipt_persisted" && prior.receipt !== undefined)
      return prior.receipt;
    if (prior !== undefined)
      return this.persistRecoveredUnknown(
        claims.mutationFence,
        claims.operationId,
        claims.tupleFingerprint,
        registrySequence,
        prior.evidence,
      );

    const sourceName = deterministicOutputName(claims);
    const first = this.config.filesystem.scanSource(sourceName);
    const validated = validateSnapshot(first, this.config);
    const second = this.config.filesystem.scanSource(sourceName);
    validateSnapshot(second, this.config);
    assertUnchanged(first, second);
    const destinationName = `${sourceName}--${encodeIdentitySegment(claims.operationId)}--${validated.treeDigest}`;
    const evidence: SealPreparedEvidence = Object.freeze({
      destinationName,
      outputParent: this.config.filesystem.outputParent,
      sourceName,
      stagingParent: this.config.filesystem.stagingParent,
      treeDigest: validated.treeDigest,
    });
    this.config.registry.wal.reserve(4);
    this.config.registry.transition(claims, "prepared", evidence);
    this.config.registry.transition(claims, "seal_call_issued", evidence);
    let outcome: "sealed" | "unknown" = "sealed";
    try {
      const staged = this.config.filesystem.atomicSeal({
        destinationName,
        expectedSource: second,
        sourceName,
      });
      validateSnapshot(staged, this.config);
      assertUnchanged(second, staged);
    } catch {
      outcome = "unknown";
    }
    this.config.registry.transition(claims, "sealed_or_unknown", evidence);
    const receipt: SealOutputReceipt = Object.freeze({
      authorityRegistrySequence: registrySequence,
      ...(outcome === "sealed"
        ? {
            entries: validated.entries,
            sealId: `seal-v1-${createHash("sha256").update(`${claims.tupleFingerprint}\u0000${validated.treeDigest}`).digest("hex")}`,
            totalBytes: validated.totalBytes,
            treeDigest: validated.treeDigest,
          }
        : { reason: "atomic_seal_outcome_ambiguous" }),
      mutationFenceFingerprint: fingerprintForFence(claims.mutationFence),
      operationId: claims.operationId,
      outcome,
      protocolVersion: 1,
      tupleFingerprint: claims.tupleFingerprint,
    });
    this.config.registry.transition(
      claims,
      "receipt_persisted",
      evidence,
      receipt,
    );
    return receipt;
  }

  private persistRecoveredUnknown(
    fence: MutationFence,
    operationId: string,
    tupleFingerprint: string,
    registrySequence: number,
    evidence: SealPreparedEvidence,
  ): SealOutputReceipt {
    const prior = this.config.registry.state(operationId);
    if (prior === undefined) throw new Error("seal_recovery_state_missing");
    if (prior.state === "prepared")
      this.config.registry.transition(
        prior.claims,
        "seal_call_issued",
        evidence,
      );
    if (["prepared", "seal_call_issued"].includes(prior.state))
      this.config.registry.transition(
        prior.claims,
        "sealed_or_unknown",
        evidence,
      );
    const receipt: SealOutputReceipt = Object.freeze({
      authorityRegistrySequence: registrySequence,
      mutationFenceFingerprint: fingerprintForFence(fence),
      operationId,
      outcome: "unknown",
      protocolVersion: 1,
      reason: "seal_recovered_without_proven_atomic_outcome",
      tupleFingerprint,
    });
    this.config.registry.transition(
      prior.claims,
      "receipt_persisted",
      evidence,
      receipt,
    );
    return receipt;
  }
}

export interface LinuxDescriptorSealFilesystemConfig {
  readonly helperPath: string;
  readonly outputRoot: string;
  readonly stagingRoot: string;
  readonly expectedWorkloadUid: number;
  readonly limits: SealLimits;
}

function runNative(helperPath: string, args: readonly string[]): string {
  const result = spawnSync(helperPath, [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.signal !== null) {
    const stderr = result.stderr.trim();
    throw new UnsafeSealTreeError(
      `native_descriptor_boundary_refused:${stderr.length > 0 ? stderr : (result.error?.message ?? "unknown")}`,
    );
  }
  return result.stdout;
}

function parseNativeSnapshot(output: string): DescriptorTreeSnapshot {
  const entries =
    output.length === 0
      ? []
      : output
          .trimEnd()
          .split("\n")
          .map((line): DescriptorTreeEntry => {
            const fields = line.split("\t");
            if (fields.length !== 11)
              throw new UnsafeSealTreeError("invalid_native_snapshot");
            const [
              type,
              encodedPath,
              device,
              inode,
              uid,
              mode,
              nlink,
              size,
              allocated,
              changeToken,
              digest,
            ] = fields;
            if (
              type === undefined ||
              encodedPath === undefined ||
              device === undefined ||
              inode === undefined ||
              uid === undefined ||
              mode === undefined ||
              nlink === undefined ||
              size === undefined ||
              allocated === undefined ||
              changeToken === undefined ||
              digest === undefined
            )
              throw new UnsafeSealTreeError("invalid_native_snapshot");
            const path = Buffer.from(encodedPath, "base64url").toString("utf8");
            return Object.freeze({
              allocatedBytes: Number(allocated),
              changeToken,
              device,
              ...(type === "f" ? { digest } : {}),
              inode,
              mode: Number(mode),
              nlink: Number(nlink),
              pathSegments: Object.freeze(path.split("/")),
              sizeBytes: Number(size),
              type: type === "f" ? "file" : "directory",
              uid: Number(uid),
              xattrs: Object.freeze([]),
            });
          });
  return Object.freeze({ entries: Object.freeze(entries) });
}

export function createLinuxDescriptorSealFilesystem(
  config: LinuxDescriptorSealFilesystemConfig,
): DescriptorSealFilesystem {
  if (process.platform !== "linux")
    throw new UnsafeSealTreeError("linux_descriptor_boundary_required");
  if (
    runNative(config.helperPath, ["probe"]).trim() !==
    "linux-descriptor-sealer-v1"
  )
    throw new UnsafeSealTreeError("native_descriptor_boundary_probe_failed");
  const output = statSync(config.outputRoot, { bigint: true });
  const staging = statSync(config.stagingRoot, { bigint: true });
  const outputParent = Object.freeze({
    device: output.dev.toString(),
    inode: output.ino.toString(),
  });
  const stagingParent = Object.freeze({
    device: staging.dev.toString(),
    inode: staging.ino.toString(),
  });
  const limitArguments = [
    String(config.limits.maxDepth),
    String(config.limits.maxEntries),
    String(config.limits.maxFileBytes),
    String(config.limits.maxTotalBytes),
  ];
  return Object.freeze({
    outputParent,
    stagingParent,
    scanSource(sourceName: string) {
      return parseNativeSnapshot(
        runNative(config.helperPath, [
          "scan",
          config.outputRoot,
          sourceName,
          String(config.expectedWorkloadUid),
          outputParent.device,
          outputParent.inode,
          ...limitArguments,
        ]),
      );
    },
    atomicSeal(
      input: Readonly<{
        sourceName: string;
        destinationName: string;
        expectedSource: DescriptorTreeSnapshot;
      }>,
    ) {
      return parseNativeSnapshot(
        runNative(config.helperPath, [
          "seal",
          config.outputRoot,
          config.stagingRoot,
          input.sourceName,
          input.destinationName,
          String(config.expectedWorkloadUid),
          outputParent.device,
          outputParent.inode,
          stagingParent.inode,
          ...limitArguments,
        ]),
      );
    },
  });
}

export interface ResultSealerRpcBoundaryConfig {
  readonly agentUid: number;
  readonly agentGid: number;
  readonly boundary: FilesystemSealBoundary;
}

export class ResultSealerRpcBoundary {
  public constructor(private readonly config: ResultSealerRpcBoundaryConfig) {}

  public handle(payload: string, peer: unknown): string {
    let requestId = "invalid-request";
    try {
      this.assertAgentPeer(peer);
      const parsed = JSON.parse(payload) as Partial<SealOutputRpcRequest>;
      if (typeof parsed.requestId === "string") requestId = parsed.requestId;
      if (
        parsed.protocolVersion !== 1 ||
        parsed.method !== "seal_output" ||
        typeof parsed.requestId !== "string" ||
        parsed.requestId.length === 0 ||
        parsed.authorization === undefined ||
        Object.keys(parsed).sort().join("\u0000") !==
          ["authorization", "method", "protocolVersion", "requestId"]
            .sort()
            .join("\u0000")
      )
        throw new Error("invalid_seal_output_rpc_request");
      const receipt = this.config.boundary.seal(parsed.authorization);
      const response: SealOutputRpcResponse = Object.freeze({
        ok: true,
        protocolVersion: 1,
        receipt,
        requestId,
      });
      return JSON.stringify(response);
    } catch (error) {
      const response: SealOutputRpcResponse = Object.freeze({
        error: Object.freeze({
          code: "seal_output_refused",
          message:
            error instanceof Error ? error.message : "seal_output_refused",
        }),
        ok: false,
        protocolVersion: 1,
        requestId,
      });
      return JSON.stringify(response);
    }
  }

  private assertAgentPeer(peer: unknown): void {
    if (typeof peer !== "object" || peer === null)
      throw new Error("untrusted_result_sealer_peer");
    const value = peer as Readonly<{
      transport?: unknown;
      uid?: unknown;
      gid?: unknown;
      pid?: unknown;
    }>;
    if (
      value.transport !== "unix" ||
      value.uid !== this.config.agentUid ||
      value.gid !== this.config.agentGid ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0
    )
      throw new Error("untrusted_result_sealer_peer");
  }
}

function fingerprintForFence(fence: MutationFence): string {
  return fingerprintMutationFence(fence);
}

export type SealAuthorityProvider = FilesystemSealBoundary;

export function createProvider(
  config: FilesystemSealBoundaryConfig,
): SealAuthorityProvider {
  return new FilesystemSealBoundary(config);
}
