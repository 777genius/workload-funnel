import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function exactKeys(value, expected) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function isWithin(root, candidate) {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

async function readProfile(path, projectRoot) {
  const [parentMetadata, canonical, canonicalParent] = await Promise.all([
    lstat(dirname(path)),
    realpath(path),
    realpath(dirname(path)),
  ]);
  if (
    canonical !== path ||
    canonicalParent !== dirname(path) ||
    !parentMetadata.isDirectory() ||
    parentMetadata.isSymbolicLink() ||
    (parentMetadata.mode & 0o022) !== 0 ||
    (process.getuid !== undefined &&
      parentMetadata.uid !== process.getuid() &&
      parentMetadata.uid !== 0) ||
    isWithin(projectRoot, path)
  )
    throw new Error("hosted_canary_trusted_profile_unsafe");
  const handle = await open(
    path,
    constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY,
  );
  let contents;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 2 ||
      metadata.size > 32 * 1024 ||
      (metadata.mode & 0o077) !== 0 ||
      (process.getuid !== undefined &&
        metadata.uid !== process.getuid() &&
        metadata.uid !== 0)
    )
      throw new Error("hosted_canary_trusted_profile_unsafe");
    contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.size !== metadata.size
    )
      throw new Error("hosted_canary_trusted_profile_changed");
  } finally {
    await handle.close();
  }
  let profile;
  try {
    profile = JSON.parse(contents);
  } catch {
    throw new Error("hosted_canary_trusted_profile_invalid");
  }
  if (
    !exactKeys(profile, [
      "accessBoundary",
      "accountSelectors",
      "authRoot",
      "executionEngine",
      "model",
      "networkAccess",
      "profileId",
      "profileRevision",
      "reasoningEffort",
      "schemaVersion",
      "serviceTier",
    ]) ||
    profile.schemaVersion !== 1 ||
    !Array.isArray(profile.accountSelectors)
  )
    throw new Error("hosted_canary_trusted_profile_invalid");
  const { schemaVersion: _schemaVersion, ...resolved } = profile;
  void _schemaVersion;
  return Object.freeze({
    ...resolved,
    accountSelectors: Object.freeze([...resolved.accountSelectors]),
  });
}

export function createTrustedInvocationProfileResolver(input) {
  if (
    !isAbsolute(input.profilePath) ||
    !isAbsolute(input.projectRoot) ||
    isWithin(input.projectRoot, input.profilePath)
  )
    throw new Error("hosted_canary_trusted_profile_path_invalid");
  const profilePath = resolve(input.profilePath);
  const projectRoot = resolve(input.projectRoot);
  return Object.freeze({
    async resolve(profileId) {
      const profile = await readProfile(profilePath, projectRoot);
      if (profile.profileId !== profileId)
        throw new Error("hosted_canary_trusted_profile_not_found");
      return profile;
    },
  });
}
