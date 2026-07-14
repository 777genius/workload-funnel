import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  artifactStageReceiptBinding,
  type ArtifactStageCommand,
  type ArtifactStageReceipt,
  type ArtifactStageWriter,
} from "@workload-funnel/node-execution/result-staging-reporting";
import type {
  ArtifactMutationAuthority,
  ResultEntry,
} from "@workload-funnel/workload-control/result-management";

export interface SealedArtifactReader {
  read(sealId: string, path: string): Promise<Uint8Array>;
}

export interface FilesystemStageWriterConfig {
  readonly authority: ArtifactMutationAuthority;
  readonly nativeHelperPath: string;
  readonly root: string;
  readonly sealedReader: SealedArtifactReader;
  readonly nowMs?: () => number;
}

function assertFence(
  fence: MutationFence,
  command: ArtifactStageCommand,
): void {
  validateMutationFence(fence);
  const uploadIdentity = command.uploadIdentity as unknown as Readonly<{
    allocationId?: unknown;
    prefix?: unknown;
    permissions?: unknown;
    canList?: unknown;
    canRead?: unknown;
    canOverwrite?: unknown;
    canDelete?: unknown;
  }>;
  if (
    fence.desiredEffect !== "artifact_stage" ||
    fence.requiredGate !== "result_finalize" ||
    fence.allocationId !== command.allocationId ||
    fence.attemptId !== command.attemptId ||
    fence.executionGeneration !== command.executionGeneration ||
    fence.effectScopeKey !== `artifact-stage:${command.executionId}` ||
    uploadIdentity.allocationId !== command.allocationId ||
    uploadIdentity.prefix !==
      `${command.allocationId}/${command.executionGeneration}/` ||
    !Array.isArray(uploadIdentity.permissions) ||
    uploadIdentity.permissions.length !== 1 ||
    uploadIdentity.permissions[0] !== "create" ||
    uploadIdentity.canList !== false ||
    uploadIdentity.canRead !== false ||
    uploadIdentity.canOverwrite !== false ||
    uploadIdentity.canDelete !== false
  )
    throw new Error("filesystem_stage_fence_mismatch");
}

function assertRelativeEntryPath(path: string): readonly string[] {
  if (
    path.startsWith("/") ||
    path !== path.normalize("NFC") ||
    path.includes("\\") ||
    path.includes("\u0000")
  )
    throw new Error("unsafe_artifact_entry_path");
  const segments = path.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  )
    throw new Error("unsafe_artifact_entry_path");
  return segments;
}

function stagingIdentity(command: ArtifactStageCommand): string {
  return `local-v2:${Buffer.from(command.allocationId).toString("base64url")}:${Buffer.from(command.executionGeneration).toString("base64url")}:${Buffer.from(fingerprintMutationFence(command.mutationFence)).toString("base64url")}:${command.manifestDigest}`;
}

interface NativeResult {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

function invokeNative(
  helperPath: string,
  args: readonly string[],
  input?: Uint8Array,
): NativeResult {
  let contentDescriptor: number | undefined;
  let contentRoot: string | undefined;
  let result: ReturnType<typeof spawnSync>;
  try {
    if (input !== undefined) {
      contentRoot = mkdtempSync(join(tmpdir(), "wf-artifact-content-"));
      const contentPath = join(contentRoot, "content");
      writeFileSync(contentPath, input, { flag: "wx", mode: 0o600 });
      contentDescriptor = openSync(contentPath, "r");
      unlinkSync(contentPath);
    }
    result = spawnSync(helperPath, [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio:
        contentDescriptor === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["ignore", "pipe", "pipe", contentDescriptor],
    });
  } finally {
    if (contentDescriptor !== undefined) closeSync(contentDescriptor);
    if (contentRoot !== undefined)
      rmSync(contentRoot, { force: true, recursive: true });
  }
  if (
    result.signal !== null ||
    (result.error !== undefined && result.status === null)
  )
    throw new Error("native_artifact_boundary_unavailable");
  return Object.freeze({
    status: result.status,
    stderr: String(result.stderr),
    stdout: String(result.stdout),
  });
}

function requireNative(
  helperPath: string,
  args: readonly string[],
  input?: Uint8Array,
): void {
  const result = invokeNative(helperPath, args, input);
  if (result.status !== 0)
    throw new Error(
      `native_artifact_boundary_refused:${result.stderr.trim() || "unknown"}`,
    );
}

export function createProvider(
  config: FilesystemStageWriterConfig,
): ArtifactStageWriter {
  const nowMs = config.nowMs ?? Date.now;
  const configuredRoot = resolve(config.root);
  if (!isAbsolute(configuredRoot))
    throw new Error("artifact_root_must_be_absolute");
  mkdirSync(configuredRoot, { recursive: true, mode: 0o700 });
  const root = realpathSync(configuredRoot);
  const rootMetadata = statSync(root, { bigint: true });
  const rootPin = [rootMetadata.dev.toString(), rootMetadata.ino.toString()];
  const probe = invokeNative(config.nativeHelperPath, ["probe"]);
  if (
    probe.status !== 0 ||
    probe.stdout.trim() !== "linux-descriptor-artifact-store-v1"
  )
    throw new Error("native_artifact_boundary_profile_mismatch");
  const writer: ArtifactStageWriter = {
    capability: "create_only_scoped_stage",
    providerId: "local-filesystem",
    async stage(command): Promise<ArtifactStageReceipt> {
      assertFence(command.mutationFence, command);
      config.authority.authorize(command.mutationFence, nowMs());
      const identity = stagingIdentity(command);
      const finalName = createHash("sha256").update(identity).digest("hex");
      const workName = `pending-${createHash("sha256")
        .update(
          `${command.operationId}\u0000${fingerprintMutationFence(command.mutationFence)}\u0000${command.manifestDigest}`,
        )
        .digest("hex")}`;
      const sortedEntries = [...command.entries].sort((left, right) =>
        left.path.localeCompare(right.path),
      );
      for (const entry of sortedEntries) assertRelativeEntryPath(entry.path);

      const existing = invokeNative(config.nativeHelperPath, [
        "verify-stage",
        root,
        ...rootPin,
        finalName,
      ]);
      if (existing.status !== 0) {
        config.authority.authorize(command.mutationFence, nowMs());
        requireNative(config.nativeHelperPath, [
          "prepare-stage",
          root,
          ...rootPin,
          workName,
        ]);
        for (const entry of sortedEntries) {
          const content = await config.sealedReader.read(
            command.sealId,
            entry.path,
          );
          if (
            content.byteLength !== entry.sizeBytes ||
            createHash("sha256").update(content).digest("hex") !== entry.digest
          )
            throw new Error("sealed_artifact_digest_mismatch");
          config.authority.authorize(command.mutationFence, nowMs());
          requireNative(
            config.nativeHelperPath,
            [
              "stage-file",
              root,
              ...rootPin,
              workName,
              entry.path,
              entry.digest,
              String(entry.sizeBytes),
            ],
            content,
          );
        }
        config.authority.authorize(command.mutationFence, nowMs());
        const commit = invokeNative(config.nativeHelperPath, [
          "commit-stage",
          root,
          ...rootPin,
          workName,
          finalName,
        ]);
        if (commit.status !== 0 && commit.status !== 17)
          throw new Error(
            `native_artifact_boundary_refused:${commit.stderr.trim() || "unknown"}`,
          );
      }

      const entries: ResultEntry[] = sortedEntries.map((entry) => {
        const segments = assertRelativeEntryPath(entry.path);
        requireNative(config.nativeHelperPath, [
          "verify-file",
          root,
          ...rootPin,
          finalName,
          entry.path,
          entry.digest,
          String(entry.sizeBytes),
        ]);
        return Object.freeze({
          checksum: entry.digest,
          location: `file+wf://local/${finalName}/${segments
            .map((segment) => Buffer.from(segment).toString("base64url"))
            .join("/")}`,
          path: entry.path,
          sizeBytes: entry.sizeBytes,
        });
      });
      const mutationFenceFingerprint = fingerprintMutationFence(
        command.mutationFence,
      );
      const receiptFields = {
        entries: Object.freeze(entries),
        immutableStagingIdentity: identity,
        manifestDigest: command.manifestDigest,
        mutationFenceFingerprint,
        operationId: command.operationId,
        providerId: "local-filesystem",
      };
      return Object.freeze({
        ...receiptFields,
        bindingDigest: artifactStageReceiptBinding(receiptFields),
        mutationFence: command.mutationFence,
        state: "staged",
      });
    },
  };
  return Object.freeze(writer);
}
