import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
} from "node:fs/promises";
import { arch, release } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  ARCHITECTURE_PLAN_SHA256,
  PINNED_IMAGES,
  REVIEW_EXCLUDED_NAMES,
  REVIEW_MANIFEST_SCHEMA,
} from "./constants.mjs";
import {
  HostedGateRefusal,
  sha256,
  validateTrustedIdentity,
} from "./contract.mjs";

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

async function syncDirectory(path) {
  const descriptor = await open(path, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

export async function writeJsonAtomically(path, value, mode = 0o600) {
  const temporary = `${path}.partial`;
  const descriptor = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    mode,
  );
  try {
    await descriptor.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await rename(temporary, path);
  await syncDirectory(dirname(path));
}

export async function inspectPathIdentity(path, { includeDigest = true } = {}) {
  const canonicalPath = await realpath(path);
  const identity = await lstat(path);
  const result = {
    canonicalPath,
    gid: identity.gid,
    kind: identity.isFile()
      ? "file"
      : identity.isDirectory()
        ? "directory"
        : "other",
    mode: identity.mode & 0o7777,
    path,
    size: identity.size,
    symlink: identity.isSymbolicLink(),
    uid: identity.uid,
  };
  if (includeDigest && identity.isFile())
    result.sha256 = sha256(await readFile(path));
  return Object.freeze(result);
}

export async function inspectExecutable(path) {
  refuse(
    !isAbsolute(path) || resolve(path) !== path,
    "executable_path_invalid",
  );
  const identity = await inspectPathIdentity(path);
  const ancestors = [];
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    ancestors.push(
      await inspectPathIdentity(directory, { includeDigest: false }),
    );
    if (directory === "/") break;
  }
  return Object.freeze({ ...identity, ancestors: Object.freeze(ancestors) });
}

export async function collectReviewedFiles(
  root,
  {
    excludedNames = REVIEW_EXCLUDED_NAMES,
    expectedGid = 0,
    expectedUid = 0,
    inspect = inspectPathIdentity,
    list = readdir,
  } = {},
) {
  refuse(
    !isAbsolute(root) || resolve(root) !== root,
    "review_root_path_invalid",
  );
  const files = [];
  const visit = async (directory) => {
    const parent = await inspect(directory, { includeDigest: false });
    refuse(
      parent.canonicalPath !== directory ||
        parent.kind !== "directory" ||
        parent.symlink === true ||
        parent.uid !== expectedUid ||
        parent.gid !== expectedGid ||
        (parent.mode & 0o022) !== 0,
      "review_directory_identity_untrusted",
    );
    const entries = await list(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excludedNames.has(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      const identity = await inspect(path);
      refuse(identity.symlink === true, "review_tree_symlink_refused");
      if (identity.kind === "directory") await visit(path);
      else {
        refuse(
          identity.kind !== "file" ||
            identity.canonicalPath !== path ||
            identity.uid !== expectedUid ||
            identity.gid !== expectedGid ||
            (identity.mode & 0o022) !== 0 ||
            !/^[a-f0-9]{64}$/u.test(identity.sha256 ?? ""),
          "review_file_identity_untrusted",
        );
        files.push(Object.freeze({ path, sha256: identity.sha256 }));
      }
    }
  };
  await visit(root);
  return Object.freeze(files);
}

export function sourceTreeDigest(reviewedFiles) {
  const paths = new Set();
  const lines = [...reviewedFiles]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((item) => {
      refuse(
        !isAbsolute(item.path) ||
          resolve(item.path) !== item.path ||
          paths.has(item.path) ||
          !/^[a-f0-9]{64}$/u.test(item.sha256),
        "reviewed_file_inventory_invalid",
      );
      paths.add(item.path);
      return `${item.path}\0${item.sha256}\n`;
    });
  return `sha256:${sha256(Buffer.from(lines.join(""), "utf8"))}`;
}

export async function createReviewManifest({
  executablePaths,
  hqArchive,
  reviewId,
  reviewRoot,
}) {
  refuse(
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(reviewId),
    "review_identifier_invalid",
  );
  const reviewedFiles = [...(await collectReviewedFiles(reviewRoot))];
  refuse(
    new Set(executablePaths).size !== executablePaths.length,
    "review_executable_inventory_duplicate",
  );
  const archiveIdentity = await inspectPathIdentity(hqArchive);
  refuse(
    archiveIdentity.kind !== "file" ||
      archiveIdentity.symlink === true ||
      archiveIdentity.canonicalPath !== hqArchive ||
      archiveIdentity.uid !== 0 ||
      archiveIdentity.gid !== 0 ||
      (archiveIdentity.mode & 0o022) !== 0,
    "hyperqueue_archive_identity_untrusted",
  );
  reviewedFiles.push(
    Object.freeze({ path: hqArchive, sha256: archiveIdentity.sha256 }),
  );
  const executableEntries = [];
  for (const path of [...executablePaths].sort()) {
    const identity = await inspectExecutable(path);
    validateTrustedIdentity(identity, { executable: true, expectedPath: path });
    executableEntries.push(
      Object.freeze({
        gid: identity.gid,
        mode: identity.mode,
        path,
        sha256: identity.sha256,
        uid: identity.uid,
      }),
    );
  }
  const architecturePath = `${reviewRoot}/docs/workload-funnel-architecture-plan.md`;
  refuse(
    reviewedFiles.find((item) => item.path === architecturePath)?.sha256 !==
      ARCHITECTURE_PLAN_SHA256,
    "architecture_plan_digest_mismatch",
  );
  const [bootId, machineId] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/etc/machine-id", "utf8"),
  ]);
  return Object.freeze({
    executables: Object.freeze(executableEntries),
    host: Object.freeze({
      architecture: arch(),
      bootIdSha256: sha256(Buffer.from(bootId.trim(), "utf8")),
      kernelRelease: release(),
      machineIdSha256: sha256(Buffer.from(machineId.trim(), "utf8")),
    }),
    images: PINNED_IMAGES,
    reviewId,
    reviewedFiles: Object.freeze(reviewedFiles),
    schemaVersion: REVIEW_MANIFEST_SCHEMA,
    sourceTreeDigest: sourceTreeDigest(reviewedFiles),
  });
}

export async function installReviewManifest(path, manifest) {
  refuse(
    Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") >
      1024 * 1024,
    "review_manifest_too_large",
  );
  await writeJsonAtomically(path, manifest, 0o400);
  await chmod(path, 0o400);
  const identity = await inspectPathIdentity(path);
  refuse(
    identity.uid !== 0 ||
      identity.gid !== 0 ||
      identity.mode !== 0o400 ||
      identity.symlink === true ||
      identity.canonicalPath !== path,
    "review_manifest_seal_failed",
  );
  return Object.freeze({ path, sha256: identity.sha256 });
}

export function sha256Sums(entries) {
  return [...entries]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => `${entry.sha256}  ${entry.name}\n`)
    .join("");
}
