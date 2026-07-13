// Pure filesystem adapter; it owns no result policy or lifecycle transition.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  compareMutationFence,
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactFinalizeCommand,
  ArtifactProvider,
  ArtifactVerificationCommand,
  ArtifactVerificationReceipt,
} from "@workload-funnel/workload-control/result-management";

export type { ArtifactFinalizeCommand } from "@workload-funnel/workload-control/result-management";

export class UnsafeArtifactPathError extends Error {
  public constructor() {
    super("Artifact path escapes or traverses an unsafe filesystem object");
    this.name = "UnsafeArtifactPathError";
  }
}

export interface LocalArtifactWriter {
  write(command: ArtifactFinalizeCommand): Promise<string>;
}

export interface SynchronousLocalArtifactWriter {
  readonly root: string;
  write(command: ArtifactFinalizeCommand): string;
}

function assertArtifactFinalizeFence(
  command: ArtifactFinalizeCommand,
  highWatermarks: Map<
    string,
    Readonly<{
      fingerprint: string;
      version: number;
    }>
  >,
  nowMs: () => number,
  commitHighWatermark: boolean,
): void {
  const mutationFence: MutationFence = command.mutationFence;
  validateMutationFence(mutationFence);
  const comparison = compareMutationFence(
    mutationFence,
    command.authority,
    nowMs(),
  );
  const pathScope = Buffer.from(command.path, "utf8").toString("base64url");
  if (
    mutationFence.desiredEffect !== "artifact_finalize" ||
    mutationFence.requiredGate !== "result_finalize" ||
    mutationFence.clusterIncarnation !== "synthetic-phase1-cluster" ||
    !mutationFence.namespaceId.startsWith("test://phase1/") ||
    mutationFence.attemptId !== command.attemptId ||
    mutationFence.effectScopeKey !==
      `artifact-finalize:${command.attemptId}:${pathScope}` ||
    mutationFence.supersessionKey !== mutationFence.effectScopeKey ||
    comparison !== "current"
  ) {
    throw new Error(`artifact_finalize_fence_mismatch:${comparison}`);
  }
  const fingerprint = fingerprintMutationFence(mutationFence);
  const prior = highWatermarks.get(mutationFence.effectScopeKey);
  if (
    prior !== undefined &&
    (prior.version > mutationFence.expectedDesiredVersion ||
      (prior.version === mutationFence.expectedDesiredVersion &&
        prior.fingerprint !== fingerprint))
  ) {
    throw new Error("artifact_finalize_stale_fence");
  }
  if (commitHighWatermark) {
    highWatermarks.set(mutationFence.effectScopeKey, {
      fingerprint,
      version: mutationFence.expectedDesiredVersion,
    });
  }
}

export function createLocalFilesystemArtifactWriter(
  root: string,
  nowMs: () => number = Date.now,
): LocalArtifactWriter {
  const absoluteRoot = resolve(root);
  const highWatermarks = new Map<
    string,
    Readonly<{ fingerprint: string; version: number }>
  >();
  const writer: LocalArtifactWriter = {
    async write(command) {
      const { attemptId, content, path } = command;
      assertArtifactFinalizeFence(command, highWatermarks, nowMs, false);
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new UnsafeArtifactPathError();
      }
      await mkdir(absoluteRoot, { recursive: true });
      const canonicalRoot = await realpath(absoluteRoot);
      const target = resolve(join(canonicalRoot, attemptId, path));
      if (relative(canonicalRoot, target).startsWith(".."))
        throw new UnsafeArtifactPathError();
      const parentRelative = relative(canonicalRoot, dirname(target));
      let current = canonicalRoot;
      for (const component of parentRelative.split(sep)) {
        if (component.length === 0 || component === ".") continue;
        current = join(current, component);
        const before = await lstat(current).catch(() => undefined);
        if (
          before?.isSymbolicLink() === true ||
          before?.isDirectory() === false
        ) {
          throw new UnsafeArtifactPathError();
        }
        if (before === undefined) await mkdir(current);
        const after = await lstat(current);
        if (!after.isDirectory() || after.isSymbolicLink())
          throw new UnsafeArtifactPathError();
      }
      const existing = await lstat(target).catch(() => undefined);
      if (existing?.isSymbolicLink() === true || existing?.isFile() === false) {
        throw new UnsafeArtifactPathError();
      }
      assertArtifactFinalizeFence(command, highWatermarks, nowMs, true);
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      return target;
    },
  };
  return Object.freeze(writer);
}

export function createDisposableSynchronousArtifactWriter(
  nowMs: () => number = Date.now,
): SynchronousLocalArtifactWriter {
  const root = mkdtempSync(join(tmpdir(), "workload-funnel-phase1-artifacts-"));
  const canonicalRoot = realpathSync(root);
  const highWatermarks = new Map<
    string,
    Readonly<{ fingerprint: string; version: number }>
  >();
  const writer: SynchronousLocalArtifactWriter = {
    root: canonicalRoot,
    write(command) {
      const { attemptId, content, path } = command;
      assertArtifactFinalizeFence(command, highWatermarks, nowMs, false);
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new UnsafeArtifactPathError();
      }
      const target = resolve(join(canonicalRoot, attemptId, path));
      if (relative(canonicalRoot, target).startsWith("..")) {
        throw new UnsafeArtifactPathError();
      }
      const parentRelative = relative(canonicalRoot, dirname(target));
      let current = canonicalRoot;
      for (const component of parentRelative.split(sep)) {
        if (component.length === 0 || component === ".") continue;
        current = join(current, component);
        const before = (() => {
          try {
            return lstatSync(current);
          } catch {
            return undefined;
          }
        })();
        if (
          before?.isSymbolicLink() === true ||
          before?.isDirectory() === false
        ) {
          throw new UnsafeArtifactPathError();
        }
        if (before === undefined) mkdirSync(current);
        const after = lstatSync(current);
        if (!after.isDirectory() || after.isSymbolicLink()) {
          throw new UnsafeArtifactPathError();
        }
      }
      const existing = (() => {
        try {
          return lstatSync(target);
        } catch {
          return undefined;
        }
      })();
      if (existing?.isSymbolicLink() === true || existing?.isFile() === false) {
        throw new UnsafeArtifactPathError();
      }
      assertArtifactFinalizeFence(command, highWatermarks, nowMs, true);
      writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
      return target;
    },
  };
  return Object.freeze(writer);
}

export interface FilesystemVerifyFinalizeConfig {
  readonly nativeHelperPath: string;
  readonly root: string;
  readonly nowMs?: () => number;
}

export function createProvider(
  config: FilesystemVerifyFinalizeConfig,
): ArtifactProvider {
  const root = resolve(config.root);
  const nowMs = config.nowMs ?? Date.now;
  const metadata = statSync(root, { bigint: true });
  const rootPin = [metadata.dev.toString(), metadata.ino.toString()];
  const invoke = (args: readonly string[]): string => {
    const result = spawnSync(config.nativeHelperPath, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || result.signal !== null)
      throw new UnsafeArtifactPathError();
    return result.stdout;
  };
  if (invoke(["probe"]).trim() !== "linux-descriptor-artifact-store-v1")
    throw new UnsafeArtifactPathError();
  return Object.freeze({
    capabilities: Object.freeze(["verify_finalized_bytes"] as const),
    providerId: "local-filesystem",
    verify(
      command: ArtifactVerificationCommand,
    ): Promise<ArtifactVerificationReceipt> {
      validateMutationFence(command.mutationFence);
      validateMutationFence(command.stagingMutationFence);
      if (
        command.mutationFence.desiredEffect !== "artifact_finalize" ||
        command.mutationFence.requiredGate !== "result_finalize" ||
        command.mutationFence.effectScopeKey !==
          `result-finalize:${command.resultManifestId}` ||
        command.stagingMutationFenceFingerprint !==
          fingerprintMutationFence(command.stagingMutationFence) ||
        command.stagingMutationFence.desiredEffect !== "artifact_stage" ||
        command.stagingMutationFence.allocationId !==
          command.mutationFence.allocationId ||
        command.stagingMutationFence.attemptId !==
          command.mutationFence.attemptId ||
        command.stagingMutationFence.executionGeneration !==
          command.mutationFence.executionGeneration ||
        command.immutableStagingIdentity !==
          `local-v2:${Buffer.from(command.stagingMutationFence.allocationId ?? "").toString("base64url")}:${Buffer.from(command.stagingMutationFence.executionGeneration).toString("base64url")}:${Buffer.from(command.stagingMutationFenceFingerprint).toString("base64url")}:${command.manifestDigest}`
      )
        throw new Error("artifact_verification_fence_mismatch");
      const directoryName = createHash("sha256")
        .update(command.immutableStagingIdentity)
        .digest("hex");
      invoke(["verify-stage", root, ...rootPin, directoryName]);
      for (const entry of command.expectedEntries) {
        if (
          entry.path.startsWith("/") ||
          entry.path
            .split("/")
            .some((segment) => segment === ".." || segment === "")
        ) {
          throw new UnsafeArtifactPathError();
        }
        invoke([
          "verify-file",
          root,
          ...rootPin,
          directoryName,
          entry.path,
          entry.checksum,
          String(entry.sizeBytes),
        ]);
      }
      return Promise.resolve(
        Object.freeze({
          immutableStagingIdentity: command.immutableStagingIdentity,
          manifestDigest: command.manifestDigest,
          operationId: command.operationId,
          providerId: "local-filesystem",
          resultManifestId: command.resultManifestId,
          status: "verified",
          verifiedAtMs: nowMs(),
          verifiedEntries: Object.freeze([...command.expectedEntries]),
        }),
      );
    },
  });
}
