import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { HostedGateRefusal } from "./contract.mjs";

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

async function classifyCandidate(path, mode, acceptExisting) {
  let descriptor;
  try {
    const linkIdentity = await lstat(path);
    refuse(
      !linkIdentity.isFile() || linkIdentity.isSymbolicLink(),
      "recoverable_json_identity_invalid",
    );
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const identity = await descriptor.stat();
    refuse(
      identity.dev !== linkIdentity.dev ||
        identity.ino !== linkIdentity.ino ||
        identity.uid !== process.getuid?.() ||
        identity.gid !== process.getgid?.() ||
        (identity.mode & 0o7777) !== mode,
      "recoverable_json_identity_invalid",
    );
    const bytes = await descriptor.readFile();
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return Object.freeze({
        identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        kind: "malformed",
      });
    }
    let accepted = false;
    try {
      accepted = acceptExisting(value) === true;
    } catch {
      return Object.freeze({
        identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        kind: "invalid",
      });
    }
    return Object.freeze({
      accepted,
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      kind: "valid",
      value,
    });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ kind: "missing" });
    throw error;
  } finally {
    await descriptor?.close();
  }
}

async function removeCandidate(path, candidate, mode, operations) {
  const identity = await lstat(path);
  refuse(
    candidate.identity === undefined ||
      identity.dev !== candidate.identity.dev ||
      identity.ino !== candidate.identity.ino ||
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.uid !== process.getuid?.() ||
      identity.gid !== process.getgid?.() ||
      (identity.mode & 0o7777) !== mode,
    "recoverable_json_identity_invalid",
  );
  await (operations.remove ?? rm)(path);
  await (operations.syncDirectory ?? syncDirectory)(dirname(path));
}

export async function writeRecoverableJsonAtomically(
  path,
  value,
  options = {},
) {
  const mode = options.mode ?? 0o600;
  refuse(
    !Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777,
    "recoverable_json_mode_invalid",
  );
  const expectedBytes = Buffer.from(
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  const acceptExisting =
    options.acceptExisting ??
    ((candidate) => isDeepStrictEqual(candidate, value));
  const operations = options.operations ?? {};
  const temporary = `${path}.partial`;
  const [primary, partial] = await Promise.all([
    classifyCandidate(path, mode, acceptExisting),
    classifyCandidate(temporary, mode, acceptExisting),
  ]);

  refuse(
    primary.kind === "malformed" || primary.kind === "invalid",
    "recoverable_json_primary_corrupt",
  );
  if (primary.kind === "valid") {
    refuse(!primary.accepted, "recoverable_json_primary_conflict");
    if (partial.kind !== "missing")
      await removeCandidate(temporary, partial, mode, operations);
    return primary.value;
  }

  if (partial.kind === "valid") {
    refuse(!partial.accepted, "recoverable_json_partial_conflict");
    await (operations.rename ?? rename)(temporary, path);
    await (operations.syncDirectory ?? syncDirectory)(dirname(path));
    return partial.value;
  }
  refuse(partial.kind === "invalid", "recoverable_json_partial_corrupt");
  if (partial.kind !== "missing")
    await removeCandidate(temporary, partial, mode, operations);

  await operations.beforeCreate?.(path, expectedBytes);
  const descriptor = await (operations.open ?? open)(
    temporary,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    mode,
  );
  try {
    if (operations.write === undefined)
      await descriptor.writeFile(expectedBytes);
    else await operations.write(descriptor, expectedBytes);
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await (operations.rename ?? rename)(temporary, path);
  await operations.afterRename?.(path);
  await (operations.syncDirectory ?? syncDirectory)(dirname(path));
  return value;
}
