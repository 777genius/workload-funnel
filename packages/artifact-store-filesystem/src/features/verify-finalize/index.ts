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

export class UnsafeArtifactPathError extends Error {
  public constructor() {
    super("Artifact path escapes or traverses an unsafe filesystem object");
    this.name = "UnsafeArtifactPathError";
  }
}

export interface LocalArtifactWriter {
  write(attemptId: string, path: string, content: string): Promise<string>;
}

export interface SynchronousLocalArtifactWriter {
  readonly root: string;
  write(attemptId: string, path: string, content: string): string;
}

export function createLocalFilesystemArtifactWriter(
  root: string,
): LocalArtifactWriter {
  const absoluteRoot = resolve(root);
  const writer: LocalArtifactWriter = {
    async write(attemptId, path, content) {
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
      await writeFile(target, content, { encoding: "utf8", flag: "wx" });
      return target;
    },
  };
  return Object.freeze(writer);
}

export function createDisposableSynchronousArtifactWriter(): SynchronousLocalArtifactWriter {
  const root = mkdtempSync(join(tmpdir(), "workload-funnel-phase1-artifacts-"));
  const canonicalRoot = realpathSync(root);
  const writer: SynchronousLocalArtifactWriter = {
    root: canonicalRoot,
    write(attemptId, path, content) {
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
      writeFileSync(target, content, { encoding: "utf8", flag: "wx" });
      return target;
    },
  };
  return Object.freeze(writer);
}
