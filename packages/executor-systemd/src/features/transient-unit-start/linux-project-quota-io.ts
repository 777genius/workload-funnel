import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

export interface NativeProjectQuotaIdentity {
  readonly device: number;
  readonly gid: number;
  readonly inode: number;
  readonly mode: number;
  readonly modifiedMs: number;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly uid: number;
}

export interface NativeProjectQuotaResult {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface NativeProjectQuotaIo {
  inspect(path: string): NativeProjectQuotaIdentity;
  run(path: string, arguments_: readonly string[]): NativeProjectQuotaResult;
}

function assertTrustedDirectory(path: string, identity: Stats): void {
  if (
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== 0 ||
    identity.gid !== 0 ||
    (identity.mode & 0o022) !== 0
  ) {
    throw new Error("project_quota_helper_ancestor_untrusted");
  }
  if (realpathSync(path) !== path)
    throw new Error("project_quota_helper_ancestor_not_canonical");
}

function inspect(path: string): NativeProjectQuotaIdentity {
  if (!isAbsolute(path) || path.includes("\0") || realpathSync(path) !== path)
    throw new Error("project_quota_helper_path_untrusted");
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    assertTrustedDirectory(parent, lstatSync(parent));
    if (parent === "/") break;
  }
  const before = lstatSync(path);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== 0 ||
    before.gid !== 0 ||
    (before.mode & 0o111) === 0 ||
    (before.mode & 0o022) !== 0 ||
    before.nlink !== 1 ||
    before.size < 1 ||
    before.size > 16 * 1024 * 1024 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.gid !== after.gid ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("project_quota_helper_identity_untrusted");
  }
  return Object.freeze({
    device: before.dev,
    gid: before.gid,
    inode: before.ino,
    mode: before.mode & 0o7777,
    modifiedMs: before.mtimeMs,
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: before.size,
    uid: before.uid,
  });
}

export const defaultNativeProjectQuotaIo: NativeProjectQuotaIo = Object.freeze({
  inspect,
  run(path: string, arguments_: readonly string[]) {
    const result = spawnSync(path, arguments_, {
      encoding: "utf8",
      env: {
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        TZ: "UTC",
      },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    return Object.freeze({
      signal: result.signal,
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    });
  },
});

export function sameNativeProjectQuotaIdentity(
  left: NativeProjectQuotaIdentity,
  right: NativeProjectQuotaIdentity,
): boolean {
  return (Object.keys(left) as (keyof NativeProjectQuotaIdentity)[]).every(
    (key) => left[key] === right[key],
  );
}
