import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
} from "node:fs/promises";
import { dirname } from "node:path";

import { HOSTED_GATE_SCHEMA } from "./constants.mjs";
import { HostedGateRefusal } from "./contract.mjs";
import { readHostState, validateHostStateEvidence } from "./host-state.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function syncDirectory(path) {
  const descriptor = await open(path, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

export function cleanupTombstonePath(context) {
  return `${context.controlRoot}.cleanup-tombstone`;
}

async function assertControlRoot(
  state,
  expectedEntries,
  { expectedGid = 0, expectedUid = 0 } = {},
) {
  const identity = await lstat(state.controlRoot);
  if (
    (await realpath(state.controlRoot)) !== state.controlRoot ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== expectedUid ||
    identity.gid !== expectedGid ||
    (identity.mode & 0o7777) !== 0o700 ||
    identity.birthtimeMs !== state.controlRootIdentity.birthtimeMs ||
    identity.dev !== state.controlRootIdentity.dev ||
    identity.ino !== state.controlRootIdentity.ino
  )
    throw new HostedGateRefusal("host_state_control_root_changed");
  const entries = await readdir(state.controlRoot);
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry, index) => entry !== expectedEntries[index])
  )
    throw new HostedGateRefusal("host_state_control_root_not_empty");
}

export async function readCleanupTombstone(
  context,
  { expectedGid = 0, expectedUid = 0 } = {},
) {
  const path = cleanupTombstonePath(context);
  let descriptor;
  try {
    const linkIdentity = await lstat(path);
    if (!linkIdentity.isFile() || linkIdentity.isSymbolicLink())
      throw new HostedGateRefusal("cleanup_tombstone_identity_invalid");
    descriptor = await open(path, "r");
    const identity = await descriptor.stat();
    if (
      identity.dev !== linkIdentity.dev ||
      identity.ino !== linkIdentity.ino ||
      identity.uid !== expectedUid ||
      identity.gid !== expectedGid ||
      (identity.mode & 0o7777) !== 0o600 ||
      (await realpath(path)) !== path
    )
      throw new HostedGateRefusal("cleanup_tombstone_identity_invalid");
    let decoded;
    try {
      decoded = JSON.parse(await descriptor.readFile("utf8"));
    } catch {
      throw new HostedGateRefusal("cleanup_tombstone_malformed");
    }
    validateHostStateEvidence(decoded, context);
    if (
      decoded.phase !== "cleaned" ||
      decoded.effects.some((effect) => effect.status !== "cleaned") ||
      decoded.gateInvocations.some(
        (invocation) => invocation.status !== "finished",
      )
    )
      throw new HostedGateRefusal("cleanup_tombstone_not_cleaned");
    return decoded;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  } finally {
    await descriptor?.close();
  }
}

export async function finalizeCleanedControlState(state, operations = {}) {
  validateHostStateEvidence(state, state.context);
  if (
    state.phase !== "cleaned" ||
    state.effects.some((effect) => effect.status !== "cleaned") ||
    state.gateInvocations.some((invocation) => invocation.status !== "finished")
  )
    throw new HostedGateRefusal("host_state_cleanup_incomplete");
  const moveState = operations.moveState ?? rename;
  const removeControl = operations.removeControl ?? rmdir;
  const removeTombstone = operations.removeTombstone ?? rm;
  const sync = operations.sync ?? syncDirectory;
  const identityOptions = {
    expectedGid: operations.expectedGid ?? 0,
    expectedUid: operations.expectedUid ?? 0,
  };
  const tombstonePath = cleanupTombstonePath(state.context);
  const statePresent = await exists(state.statePath);
  let tombstone = await readCleanupTombstone(state.context, identityOptions);
  if (statePresent) {
    if (tombstone !== undefined)
      throw new HostedGateRefusal("cleanup_tombstone_conflict");
    const current = await readHostState(state.context);
    if (current.journalChecksum !== state.journalChecksum)
      throw new HostedGateRefusal("cleanup_tombstone_state_changed");
    await assertControlRoot(state, ["host-state.json"], identityOptions);
    await moveState(state.statePath, tombstonePath);
    await sync(dirname(state.controlRoot));
    tombstone = await readCleanupTombstone(state.context, identityOptions);
  }
  if (tombstone === undefined) return;
  if (await exists(state.controlRoot)) {
    await assertControlRoot(tombstone, [], identityOptions);
    await sync(state.controlRoot);
    await removeControl(state.controlRoot);
    await sync(dirname(state.controlRoot));
  }
  const durableTombstone = await readCleanupTombstone(
    state.context,
    identityOptions,
  );
  if (durableTombstone !== undefined) {
    await removeTombstone(tombstonePath);
    await sync(dirname(tombstonePath));
  }
}

export async function readCleanedEvidence(
  context,
  { expectedGid = 0, expectedUid = 0 } = {},
) {
  const readExactJson = async (name) => {
    const path = `${context.artifactRoot}/${name}`;
    let descriptor;
    try {
      const linkIdentity = await lstat(path);
      if (!linkIdentity.isFile() || linkIdentity.isSymbolicLink())
        throw new HostedGateRefusal("cleaned_evidence_identity_invalid");
      descriptor = await open(path, "r");
      const identity = await descriptor.stat();
      if (
        identity.dev !== linkIdentity.dev ||
        identity.ino !== linkIdentity.ino ||
        identity.uid !== expectedUid ||
        identity.gid !== expectedGid ||
        (identity.mode & 0o7777) !== 0o444 ||
        (await realpath(path)) !== path
      )
        throw new HostedGateRefusal("cleaned_evidence_identity_invalid");
      return JSON.parse(await descriptor.readFile("utf8"));
    } catch (error) {
      if (error instanceof HostedGateRefusal) throw error;
      throw new HostedGateRefusal("cleaned_evidence_malformed");
    } finally {
      await descriptor?.close();
    }
  };
  const state = validateHostStateEvidence(
    await readExactJson("host-state-evidence.json"),
    context,
  );
  if (
    state.phase !== "cleaned" ||
    state.effects.some((effect) => effect.status !== "cleaned") ||
    state.gateInvocations.some((invocation) => invocation.status !== "finished")
  )
    throw new HostedGateRefusal("cleaned_evidence_incomplete");
  const cleanup = await readExactJson("host-cleanup.json");
  if (
    cleanup === null ||
    typeof cleanup !== "object" ||
    Array.isArray(cleanup) ||
    Object.keys(cleanup).length !== 5 ||
    Object.keys(cleanup).some(
      (key) =>
        !new Set([
          "certain",
          "failed",
          "results",
          "runId",
          "schemaVersion",
        ]).has(key),
    ) ||
    cleanup.schemaVersion !== HOSTED_GATE_SCHEMA ||
    cleanup.runId !== context.runId ||
    cleanup.certain !== true ||
    !Array.isArray(cleanup.failed) ||
    cleanup.failed.length !== 0 ||
    !Array.isArray(cleanup.results) ||
    cleanup.results.length < 1 ||
    cleanup.results.some(
      (result) =>
        result === null ||
        typeof result !== "object" ||
        Object.keys(result).length !== 2 ||
        typeof result.id !== "string" ||
        result.ok !== true,
    )
  )
    throw new HostedGateRefusal("cleaned_evidence_incomplete");
  return Object.freeze({ cleanup, state });
}
