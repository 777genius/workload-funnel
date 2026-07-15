import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { chown, lstat, readFile, rm, writeFile } from "node:fs/promises";

export function gateSecret(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function gateIdentifier(bytes = 12) {
  return randomBytes(bytes).toString("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function cleanupSecretFileRecord(record) {
  const path = record.expected.path;
  if (typeof path !== "string" || !path.startsWith("/"))
    throw new Error("secret_file_cleanup_identity_invalid");
  let identity;
  try {
    identity = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const observed = record.observed;
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    (observed.device !== undefined && observed.device !== identity.dev) ||
    (observed.inode !== undefined && observed.inode !== identity.ino) ||
    (observed.sha256 ?? record.expected.sha256) !== sha256(await readFile(path))
  )
    throw new Error("secret_file_cleanup_identity_changed");
  await rm(path);
}

export async function writeSecretFile({
  contents,
  ledger,
  owner = { gid: process.getgid?.(), uid: process.getuid?.() },
  path,
  runId,
  sandboxRoot,
}) {
  if (
    typeof contents !== "string" ||
    contents.length < 1 ||
    contents.length > 64 * 1024 ||
    contents.includes("\0") ||
    !path.startsWith(`${sandboxRoot}/`) ||
    path.includes("\0") ||
    !Number.isSafeInteger(owner.uid) ||
    owner.uid < 0 ||
    !Number.isSafeInteger(owner.gid) ||
    owner.gid < 0
  )
    throw new Error("unsafe_secret_file");
  const name = `${runId}-${path.split("/").at(-1)}`;
  const expectedSha256 = sha256(Buffer.from(contents, "utf8"));
  const recordId = await ledger.prepare("secret-file", name, {
    path,
    sha256: expectedSha256,
  });
  await writeFile(path, contents, { flag: "wx", mode: 0o400 });
  await chown(path, owner.uid, owner.gid);
  const identity = await lstat(path);
  const observed = {
    device: identity.dev,
    inode: identity.ino,
    sha256: expectedSha256,
  };
  await ledger.finalize(recordId, observed, () =>
    cleanupSecretFileRecord({
      expected: { path, sha256: expectedSha256 },
      observed,
    }),
  );
  return path;
}
