import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname } from "node:path";

async function assertTrustedAncestors(path) {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    const descriptor = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const identity = await descriptor.stat({ bigint: true });
      if (
        !identity.isDirectory() ||
        identity.uid !== 0n ||
        identity.gid !== 0n ||
        (identity.mode & 0o022n) !== 0n
      )
        throw new Error("gate_executable_parent_untrusted");
    } finally {
      await descriptor.close();
    }
    if (directory === "/") return;
  }
}

function identityOf(stat, digest, path) {
  return Object.freeze({
    device: stat.dev,
    gid: stat.gid,
    inode: stat.ino,
    mode: stat.mode & 0o7777,
    modifiedNs: stat.mtimeNs.toString(),
    path,
    sha256: digest,
    size: stat.size,
    uid: stat.uid,
  });
}

function sameIdentity(left, right) {
  return (
    left.device === right.device &&
    left.gid === right.gid &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.path === right.path &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.uid === right.uid
  );
}

export async function inspectCanonicalExecutable(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0"))
    throw new Error("gate_executable_path_invalid");
  if ((await realpath(path)) !== path)
    throw new Error("gate_executable_path_not_canonical");
  await assertTrustedAncestors(path);
  const descriptor = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await descriptor.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.uid !== 0n ||
      before.gid !== 0n ||
      (before.mode & 0o111n) === 0n ||
      (before.mode & 0o022n) !== 0n ||
      before.size < 1n ||
      before.size > 512n * 1024n * 1024n
    )
      throw new Error("gate_executable_owner_or_mode_untrusted");
    const bytes = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    const beforeIdentity = {
      dev: Number(before.dev),
      gid: Number(before.gid),
      ino: Number(before.ino),
      mode: Number(before.mode),
      mtimeNs: before.mtimeNs,
      size: Number(before.size),
      uid: Number(before.uid),
    };
    const afterIdentity = {
      dev: Number(after.dev),
      gid: Number(after.gid),
      ino: Number(after.ino),
      mode: Number(after.mode),
      mtimeNs: after.mtimeNs,
      size: Number(after.size),
      uid: Number(after.uid),
    };
    if (
      beforeIdentity.dev !== afterIdentity.dev ||
      beforeIdentity.ino !== afterIdentity.ino ||
      beforeIdentity.mode !== afterIdentity.mode ||
      beforeIdentity.mtimeNs !== afterIdentity.mtimeNs ||
      beforeIdentity.size !== afterIdentity.size ||
      beforeIdentity.uid !== afterIdentity.uid ||
      beforeIdentity.gid !== afterIdentity.gid
    )
      throw new Error("gate_executable_changed_while_reviewed");
    return identityOf(
      beforeIdentity,
      createHash("sha256").update(bytes).digest("hex"),
      path,
    );
  } finally {
    await descriptor.close();
  }
}

export class ReviewedExecutableSet {
  #identities;

  constructor(identities) {
    this.#identities = new Map(identities.map((value) => [value.path, value]));
    if (this.#identities.size !== identities.length)
      throw new Error("duplicate_reviewed_executable");
  }

  evidence() {
    return Object.freeze(
      [...this.#identities.values()].map((identity) =>
        Object.freeze({ ...identity }),
      ),
    );
  }

  async assertUnchanged(path) {
    const expected = this.#identities.get(path);
    if (expected === undefined)
      throw new Error("gate_executable_not_in_review_manifest");
    const observed = await inspectCanonicalExecutable(path);
    if (!sameIdentity(expected, observed))
      throw new Error("gate_executable_identity_changed");
  }
}
