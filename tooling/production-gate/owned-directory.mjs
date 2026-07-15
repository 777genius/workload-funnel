import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

async function syncDirectory(path) {
  const descriptor = await open(path, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

function expectedDirectory(record) {
  const expected = record.expected;
  if (
    typeof expected?.path !== "string" ||
    !expected.path.startsWith("/") ||
    !Number.isSafeInteger(expected.uid) ||
    !Number.isSafeInteger(expected.gid) ||
    !Number.isSafeInteger(expected.mode)
  )
    throw new Error("owned_directory_cleanup_identity_invalid");
  return expected;
}

export async function cleanupOwnedDirectoryRecord(record) {
  const expected = expectedDirectory(record);
  let identity;
  try {
    identity = await lstat(expected.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const preparedCreatorOwnership =
    record.state === "prepared" &&
    record.observed.device === undefined &&
    record.observed.inode === undefined &&
    identity.uid === process.getuid?.() &&
    identity.gid === process.getgid?.();
  if (
    (await realpath(expected.path)) !== expected.path ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    ((identity.uid !== expected.uid || identity.gid !== expected.gid) &&
      !preparedCreatorOwnership) ||
    (identity.mode & 0o7777) !== expected.mode ||
    (record.observed.device !== undefined &&
      record.observed.device !== identity.dev) ||
    (record.observed.inode !== undefined &&
      record.observed.inode !== identity.ino)
  )
    throw new Error("owned_directory_cleanup_identity_changed");
  await rm(expected.path, { recursive: true });
  await syncDirectory(dirname(expected.path));
}

export async function createOwnedDirectory({
  gid,
  ledger,
  mode,
  name,
  path,
  runId,
  sandboxRoot,
  uid,
}) {
  if (
    path !== `${sandboxRoot}/${name}` ||
    name !== "postgres-data" ||
    !path.startsWith(`${sandboxRoot}/`) ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1 ||
    mode !== 0o700
  )
    throw new Error("owned_directory_configuration_invalid");
  const recordId = await ledger.prepare("owned-directory", `${runId}-${name}`, {
    gid,
    mode,
    path,
    uid,
  });
  await mkdir(path, { mode });
  await chown(path, uid, gid);
  await chmod(path, mode);
  await syncDirectory(path);
  await syncDirectory(dirname(path));
  const identity = await lstat(path);
  if (
    (await realpath(path)) !== path ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== uid ||
    identity.gid !== gid ||
    (identity.mode & 0o7777) !== mode
  )
    throw new Error("owned_directory_identity_untrusted");
  const observed = { device: identity.dev, inode: identity.ino };
  await ledger.finalize(recordId, observed, () =>
    cleanupOwnedDirectoryRecord({
      expected: { gid, mode, path, uid },
      observed,
    }),
  );
  return Object.freeze({
    crashRecoveryDurable: true,
    gid,
    mode,
    path,
    uid,
  });
}
