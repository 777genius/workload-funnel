import { Buffer } from "node:buffer";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { HOSTED_GATE_SCHEMA } from "./constants.mjs";
import { HostedGateRefusal, sha256 } from "./contract.mjs";
import { writeJsonAtomically } from "./review-manifest.mjs";

const EFFECT_STATES = new Set(["applied", "cleaned", "prepared"]);
const GATE_CHILD_STATES = new Set(["finished", "planned", "started"]);

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

function validateEffect(effect) {
  refuse(
    effect === null ||
      typeof effect !== "object" ||
      Array.isArray(effect) ||
      !/^[a-z0-9][a-z0-9:._-]{0,159}$/u.test(effect.id ?? "") ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(effect.kind ?? "") ||
      !EFFECT_STATES.has(effect.status),
    "host_state_effect_invalid",
  );
  return effect;
}

function validateGateInvocation(invocation) {
  refuse(
    invocation === null ||
      typeof invocation !== "object" ||
      Array.isArray(invocation) ||
      !new Set(["cleanup-1", "cleanup-2", "gate"]).has(invocation.id) ||
      !GATE_CHILD_STATES.has(invocation.status) ||
      !/^wf-production-gate-[a-f0-9]{32}-(?:cleanup-[12]|gate)\.service$/u.test(
        invocation.unit ?? "",
      ) ||
      !/^[a-f0-9]{64}$/u.test(invocation.marker ?? "") ||
      (invocation.status !== "planned" &&
        invocation.outcome !== "never-spawned" &&
        (!Number.isSafeInteger(invocation.pid) ||
          invocation.pid < 2 ||
          !/^[1-9][0-9]*$/u.test(invocation.starttime ?? "") ||
          typeof invocation.executable !== "string" ||
          !invocation.executable.startsWith("/") ||
          typeof invocation.cgroup !== "string" ||
          !invocation.cgroup.includes(invocation.unit))) ||
      (invocation.status === "finished" &&
        (!Number.isSafeInteger(invocation.exitCode) ||
          invocation.exitCode < 0 ||
          invocation.exitCode > 255 ||
          !new Set([
            "completed",
            "never-spawned",
            "recovered-absent",
            "recovered-killed",
          ]).has(invocation.outcome))),
    "host_state_gate_invocation_invalid",
  );
  return invocation;
}

function journalChecksum(state) {
  const payload = { ...state };
  delete payload.journalChecksum;
  return sha256(Buffer.from(JSON.stringify(payload), "utf8"));
}

function validateState(decoded, context, verifyChecksum = true) {
  const path = `${context.controlRoot}/host-state.json`;
  refuse(
    decoded === null ||
      typeof decoded !== "object" ||
      Array.isArray(decoded) ||
      decoded.schemaVersion !== HOSTED_GATE_SCHEMA ||
      !isDeepStrictEqual(decoded.context, context) ||
      decoded.hostRoot !== context.hostRoot ||
      decoded.controlRoot !== context.controlRoot ||
      decoded.controlRootIdentity === null ||
      typeof decoded.controlRootIdentity !== "object" ||
      !Number.isFinite(decoded.controlRootIdentity.birthtimeMs) ||
      decoded.controlRootIdentity.birthtimeMs < 0 ||
      !Number.isSafeInteger(decoded.controlRootIdentity.dev) ||
      !Number.isSafeInteger(decoded.controlRootIdentity.ino) ||
      decoded.controlRootIdentity.dev < 0 ||
      decoded.controlRootIdentity.ino < 1 ||
      decoded.statePath !== path ||
      !/^[a-f0-9]{64}$/u.test(decoded.journalChecksum ?? "") ||
      (verifyChecksum &&
        decoded.journalChecksum !== journalChecksum(decoded)) ||
      !new Set(["cleaned", "prepared", "preparing"]).has(decoded.phase) ||
      !Number.isSafeInteger(decoded.revision) ||
      decoded.revision < 0 ||
      !Array.isArray(decoded.effects),
    "host_state_identity_invalid",
  );
  const ids = new Set();
  for (const effect of decoded.effects) {
    validateEffect(effect);
    refuse(ids.has(effect.id), "host_state_effect_duplicate");
    ids.add(effect.id);
  }
  refuse(
    !Array.isArray(decoded.gateInvocations),
    "host_state_identity_invalid",
  );
  const invocationIds = new Set();
  for (const invocation of decoded.gateInvocations) {
    validateGateInvocation(invocation);
    refuse(
      invocationIds.has(invocation.id),
      "host_state_gate_invocation_duplicate",
    );
    invocationIds.add(invocation.id);
  }
  return decoded;
}

async function classifyCandidate(path, context) {
  let descriptor;
  try {
    const linkIdentity = await lstat(path);
    refuse(
      !linkIdentity.isFile() || linkIdentity.isSymbolicLink(),
      "host_state_file_identity_invalid",
    );
    descriptor = await open(path, "r");
    const identity = await descriptor.stat();
    refuse(
      identity.dev !== linkIdentity.dev ||
        identity.ino !== linkIdentity.ino ||
        identity.uid !== process.getuid?.() ||
        identity.gid !== process.getgid?.() ||
        (identity.mode & 0o7777) !== 0o600,
      "host_state_file_identity_invalid",
    );
    const bytes = await descriptor.readFile({ encoding: "utf8" });
    try {
      return Object.freeze({
        identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        kind: "valid",
        state: validateState(JSON.parse(bytes), context),
      });
    } catch {
      return Object.freeze({
        identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
        kind: "malformed",
      });
    }
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ kind: "missing" });
    if (error instanceof HostedGateRefusal) throw error;
    throw new HostedGateRefusal("host_state_malformed");
  } finally {
    await descriptor?.close();
  }
}

async function removeCandidate(path, candidate) {
  const identity = await lstat(path);
  refuse(
    candidate.identity === undefined ||
      identity.dev !== candidate.identity.dev ||
      identity.ino !== candidate.identity.ino ||
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.uid !== process.getuid?.() ||
      identity.gid !== process.getgid?.() ||
      (identity.mode & 0o7777) !== 0o600,
    "host_state_file_identity_invalid",
  );
  await rm(path);
  await syncDirectory(dirname(path));
}

async function readValidCandidate(path, context) {
  const candidate = await classifyCandidate(path, context);
  if (candidate.kind === "missing") return undefined;
  refuse(candidate.kind !== "valid", "host_state_malformed");
  return candidate.state;
}

export async function createHostState(
  context,
  preparedAt,
  bootstrapExecutables = {},
) {
  const statePath = `${context.controlRoot}/host-state.json`;
  refuse(
    !context.controlRoot.startsWith("/") ||
      context.controlRoot === context.artifactRoot ||
      context.controlRoot === context.hostRoot ||
      context.controlRoot.startsWith(`${context.artifactRoot}/`) ||
      context.controlRoot.startsWith(`${context.hostRoot}/`),
    "host_state_control_root_invalid",
  );
  let created = false;
  try {
    await mkdir(context.controlRoot, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const controlIdentity = await lstat(context.controlRoot);
  refuse(
    (await realpath(context.controlRoot)) !== context.controlRoot ||
      !controlIdentity.isDirectory() ||
      controlIdentity.isSymbolicLink() ||
      controlIdentity.uid !== process.getuid?.() ||
      controlIdentity.gid !== process.getgid?.() ||
      (controlIdentity.mode & 0o7777) !== 0o700,
    "host_state_control_root_invalid",
  );
  if (created) await syncDirectory(dirname(context.controlRoot));
  const [primary, partial] = await Promise.all([
    classifyCandidate(statePath, context),
    classifyCandidate(`${statePath}.partial`, context),
  ]);
  refuse(
    primary.kind === "malformed" || partial.kind === "malformed",
    "host_state_malformed",
  );
  refuse(
    primary.kind !== "missing" || partial.kind !== "missing",
    "host_state_exists",
  );
  const state = {
    artifactRoot: context.artifactRoot,
    bootstrapExecutables,
    controlRoot: context.controlRoot,
    controlRootIdentity: Object.freeze({
      birthtimeMs: controlIdentity.birthtimeMs,
      dev: controlIdentity.dev,
      ino: controlIdentity.ino,
    }),
    context,
    effects: [],
    gateInvocations: [],
    hostRoot: context.hostRoot,
    journalChecksum: "",
    phase: "preparing",
    preparedAt,
    revision: 0,
    schemaVersion: HOSTED_GATE_SCHEMA,
    statePath,
  };
  state.journalChecksum = journalChecksum(state);
  await writeJsonAtomically(statePath, state);
  const reopened = await readValidCandidate(statePath, context);
  refuse(!isDeepStrictEqual(reopened, state), "host_state_reopen_mismatch");
  return state;
}

export async function readHostState(context) {
  const path = `${context.controlRoot}/host-state.json`;
  const partialPath = `${path}.partial`;
  const [primaryCandidate, partialCandidate] = await Promise.all([
    classifyCandidate(path, context),
    classifyCandidate(partialPath, context),
  ]);
  refuse(primaryCandidate.kind === "malformed", "host_state_malformed");
  if (
    primaryCandidate.kind === "valid" &&
    partialCandidate.kind === "malformed"
  ) {
    await removeCandidate(partialPath, partialCandidate);
    return primaryCandidate.state;
  }
  refuse(partialCandidate.kind === "malformed", "host_state_malformed");
  const primary = primaryCandidate.state;
  const partial = partialCandidate.state;
  refuse(primary === undefined && partial === undefined, "host_state_missing");
  if (
    primary !== undefined &&
    partial !== undefined &&
    primary.revision === partial.revision
  )
    refuse(
      !isDeepStrictEqual(primary, partial),
      "host_state_revision_conflict",
    );
  if (partial !== undefined && partial.revision >= (primary?.revision ?? -1)) {
    await rename(partialPath, path);
    await syncDirectory(dirname(path));
    return partial;
  }
  if (partial !== undefined) {
    await removeCandidate(partialPath, partialCandidate);
  }
  return primary;
}

export async function saveHostState(state) {
  validateState(state, state.context, false);
  state.revision += 1;
  state.journalChecksum = journalChecksum(state);
  await writeJsonAtomically(state.statePath, state);
  const reopened = await readValidCandidate(state.statePath, state.context);
  refuse(!isDeepStrictEqual(reopened, state), "host_state_reopen_mismatch");
  return state;
}

export function validateHostStateEvidence(state, context) {
  return validateState(state, context);
}

export function getHostEffect(state, id) {
  return state.effects.find((effect) => effect.id === id);
}

export async function prepareHostEffect(state, effect) {
  refuse(
    effect === null ||
      typeof effect !== "object" ||
      Array.isArray(effect) ||
      Object.hasOwn(effect, "status"),
    "host_state_effect_invalid",
  );
  const prepared = validateEffect({ ...effect, status: "prepared" });
  const existing = getHostEffect(state, prepared.id);
  if (existing !== undefined) {
    refuse(
      !isDeepStrictEqual(existing, prepared),
      "host_state_effect_conflict",
    );
    return existing;
  }
  state.effects.push(prepared);
  await saveHostState(state);
  return prepared;
}

export async function applyHostEffect(state, id, identity = {}) {
  const index = state.effects.findIndex((effect) => effect.id === id);
  refuse(index < 0, "host_state_effect_missing");
  const current = state.effects[index];
  const applied = validateEffect({
    ...current,
    ...identity,
    id: current.id,
    kind: current.kind,
    status: "applied",
  });
  if (current.status === "applied") {
    refuse(!isDeepStrictEqual(current, applied), "host_state_effect_conflict");
    return current;
  }
  refuse(current.status !== "prepared", "host_state_effect_transition_invalid");
  state.effects[index] = applied;
  await saveHostState(state);
  return applied;
}

export async function markHostEffectCleaned(state, id) {
  const index = state.effects.findIndex((effect) => effect.id === id);
  refuse(index < 0, "host_state_effect_missing");
  if (state.effects[index].status === "cleaned") return state.effects[index];
  state.effects[index] = { ...state.effects[index], status: "cleaned" };
  await saveHostState(state);
  return state.effects[index];
}

export async function markHostPrepared(state) {
  refuse(state.phase !== "preparing", "host_state_phase_invalid");
  state.phase = "prepared";
  await saveHostState(state);
}

export async function markHostCleaned(state) {
  refuse(
    state.effects.some((effect) => effect.status !== "cleaned") ||
      state.gateInvocations.some(
        (invocation) => invocation.status !== "finished",
      ),
    "host_state_cleanup_incomplete",
  );
  if (state.phase !== "cleaned") {
    state.phase = "cleaned";
    await saveHostState(state);
  }
}
