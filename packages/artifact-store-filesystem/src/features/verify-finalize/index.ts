// Pure filesystem adapter; it owns no result policy or lifecycle transition.
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
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
import type { ArtifactFinalizeCommand } from "@workload-funnel/workload-control/result-management";

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
