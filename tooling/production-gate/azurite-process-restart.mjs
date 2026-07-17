import { setTimeout as delay } from "node:timers/promises";

import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";

export const AZURITE_SUPERVISOR_STATE_FILE =
  "/tmp/workload-funnel-azurite-supervisor.state";
const SIGNAL_SHELL = "/bin/sh";
const SIGNAL_SCRIPT = 'kill -USR1 "$1"';
const SIGNAL_ARGV0 = "workload-funnel-azurite-signal";

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseAzuriteSupervisorState(output) {
  const match =
    typeof output === "string"
      ? output.match(
          /^workload-funnel\.azurite-supervisor\.v1\|([1-9]\d*)\|([1-9]\d*)\|([1-9]\d*)$/u,
        )
      : null;
  const state =
    match === null
      ? undefined
      : {
          generation: Number(match[2]),
          serverPid: Number(match[3]),
          supervisorPid: Number(match[1]),
        };
  if (
    state === undefined ||
    !positiveSafeInteger(state.generation) ||
    !positiveSafeInteger(state.serverPid) ||
    !positiveSafeInteger(state.supervisorPid)
  )
    throw new Error("azurite_restart_evidence_malformed");
  return Object.freeze(state);
}

export function proveAzuriteProcessRestart({
  after,
  before,
  containerBoundaryPidAfter,
  containerBoundaryPidBefore,
  containerIdentity,
}) {
  if (
    !positiveSafeInteger(containerBoundaryPidAfter) ||
    containerBoundaryPidAfter !== containerBoundaryPidBefore ||
    !/^[a-f0-9]{12,64}$/u.test(containerIdentity) ||
    after.supervisorPid !== before.supervisorPid ||
    after.generation !== before.generation + 1 ||
    after.serverPid === before.serverPid
  )
    throw new Error("azurite_restart_evidence_stale");
  return Object.freeze({
    containerBoundaryPid: containerBoundaryPidAfter,
    containerBoundaryStable: true,
    containerIdentity,
    containerIdentityStable: true,
    currentServerGeneration: after.generation,
    currentServerPid: after.serverPid,
    previousServerGeneration: before.generation,
    previousServerPid: before.serverPid,
    schemaVersion:
      "workload-funnel.azurite-server-process-restart-observation.v1",
    serverProcessGenerationChanged: true,
    serverProcessPidChanged: true,
    supervisorBoundaryStable: true,
    supervisorPid: after.supervisorPid,
  });
}

async function observe(runtime, name, identity) {
  const boundary = await runtime.command([
    "container",
    "inspect",
    '--format={{.State.Status}}|{{.State.Pid}}|{{.Id}}|{{.Name}}|{{index .Config.Labels "workload-funnel.production-gate.resource"}}',
    identity,
  ]);
  const [status, pidText, observedIdentity, observedName, observedLabel] =
    boundary.split("|");
  const containerBoundaryPid = Number(pidText);
  if (
    status !== "running" ||
    !positiveSafeInteger(containerBoundaryPid) ||
    observedIdentity !== identity ||
    observedName !== `/${name}` ||
    observedLabel !== name
  )
    throw new Error("azurite_restart_container_boundary_unproven");
  const state = parseAzuriteSupervisorState(
    await runtime.command([
      "exec",
      identity,
      "/bin/cat",
      AZURITE_SUPERVISOR_STATE_FILE,
    ]),
  );
  return Object.freeze({ containerBoundaryPid, state });
}

export async function restartAzuriteServerProcessWithDocker({
  identity,
  name,
  runtime,
}) {
  if (
    !OWNED_RESOURCE_PATTERN.test(name) ||
    !name.endsWith("-azure") ||
    !/^[a-f0-9]{12,64}$/u.test(identity)
  )
    throw new Error("azurite_restart_identity_invalid");
  const before = await observe(runtime, name, identity);
  const signaled = await runtime.command(
    [
      "exec",
      identity,
      SIGNAL_SHELL,
      "-c",
      SIGNAL_SCRIPT,
      SIGNAL_ARGV0,
      String(before.state.supervisorPid),
    ],
    5_000,
  );
  if (signaled !== "") throw new Error("azurite_restart_signal_unproven");
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const after = await observe(runtime, name, identity);
    if (after.state.generation === before.state.generation) {
      if (attempt < 100) await delay(50);
      continue;
    }
    return proveAzuriteProcessRestart({
      after: after.state,
      before: before.state,
      containerBoundaryPidAfter: after.containerBoundaryPid,
      containerBoundaryPidBefore: before.containerBoundaryPid,
      containerIdentity: identity,
    });
  }
  throw new Error("azurite_restart_evidence_stale");
}
