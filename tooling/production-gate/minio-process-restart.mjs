import { setTimeout as delay } from "node:timers/promises";

import { OWNED_RESOURCE_PATTERN } from "./constants.mjs";

export const MINIO_SUPERVISOR_STATE_FILE =
  "/tmp/workload-funnel-minio-supervisor.state";
export const MINIO_SIGNAL_SHELL = "/bin/sh";
export const MINIO_SIGNAL_SCRIPT = 'kill -USR1 "$1"';
export const MINIO_SIGNAL_ARGV0 = "workload-funnel-minio-signal";

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function parseMinioSupervisorState(output) {
  const match =
    typeof output === "string"
      ? output.match(
          /^workload-funnel\.minio-supervisor\.v1\|([1-9]\d*)\|([1-9]\d*)\|([1-9]\d*)$/u,
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
    throw new Error("minio_restart_evidence_malformed");
  return Object.freeze(state);
}

export function proveMinioProcessRestart({
  after,
  before,
  containerBoundaryPidAfter,
  containerBoundaryPidBefore,
  containerIdentity,
}) {
  if (
    after === null ||
    typeof after !== "object" ||
    before === null ||
    typeof before !== "object" ||
    !positiveSafeInteger(after.generation) ||
    !positiveSafeInteger(after.serverPid) ||
    !positiveSafeInteger(after.supervisorPid) ||
    !positiveSafeInteger(before.generation) ||
    !positiveSafeInteger(before.serverPid) ||
    !positiveSafeInteger(before.supervisorPid) ||
    !/^[a-f0-9]{12,64}$/u.test(containerIdentity) ||
    !positiveSafeInteger(containerBoundaryPidBefore) ||
    containerBoundaryPidAfter !== containerBoundaryPidBefore ||
    after.supervisorPid !== before.supervisorPid ||
    after.generation !== before.generation + 1 ||
    after.serverPid === before.serverPid
  )
    throw new Error("minio_restart_evidence_stale");
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
      "workload-funnel.minio-server-process-restart-observation.v1",
    serverProcessGenerationChanged: true,
    serverProcessPidChanged: true,
    supervisorBoundaryStable: true,
    supervisorPid: after.supervisorPid,
  });
}

async function observeMinioServerProcess(runtime, name, identity) {
  const boundary = await runtime.command([
    "container",
    "inspect",
    '--format={{.State.Status}}|{{.State.Pid}}|{{.Id}}|{{.Name}}|{{index .Config.Labels "workload-funnel.production-gate.resource"}}',
    identity,
  ]);
  const [
    status,
    containerPidText,
    observedIdentity,
    observedName,
    observedLabel,
  ] = boundary.split("|");
  const containerBoundaryPid = Number(containerPidText);
  if (
    status !== "running" ||
    !Number.isSafeInteger(containerBoundaryPid) ||
    containerBoundaryPid < 2 ||
    observedIdentity !== identity ||
    observedName !== `/${name}` ||
    observedLabel !== name
  )
    throw new Error("minio_restart_container_boundary_unproven");
  const state = parseMinioSupervisorState(
    await runtime.command([
      "exec",
      identity,
      "/bin/cat",
      MINIO_SUPERVISOR_STATE_FILE,
    ]),
  );
  return Object.freeze({ containerBoundaryPid, state });
}

export async function restartMinioServerProcessWithDocker({
  identity,
  name,
  runtime,
}) {
  if (
    !OWNED_RESOURCE_PATTERN.test(name) ||
    !name.endsWith("-object") ||
    !/^[a-f0-9]{12,64}$/u.test(identity)
  )
    throw new Error("minio_restart_identity_invalid");
  const before = await observeMinioServerProcess(runtime, name, identity);
  const signaled = await runtime.command(
    [
      "exec",
      identity,
      MINIO_SIGNAL_SHELL,
      "-c",
      MINIO_SIGNAL_SCRIPT,
      MINIO_SIGNAL_ARGV0,
      String(before.state.supervisorPid),
    ],
    5_000,
  );
  if (signaled !== "") throw new Error("minio_restart_signal_unproven");
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const after = await observeMinioServerProcess(runtime, name, identity);
    if (after.state.generation === before.state.generation) {
      if (
        after.state.serverPid !== before.state.serverPid ||
        after.state.supervisorPid !== before.state.supervisorPid ||
        after.containerBoundaryPid !== before.containerBoundaryPid
      )
        throw new Error("minio_restart_evidence_stale");
      if (attempt < 100) await delay(50);
      continue;
    }
    return proveMinioProcessRestart({
      after: after.state,
      before: before.state,
      containerBoundaryPidAfter: after.containerBoundaryPid,
      containerBoundaryPidBefore: before.containerBoundaryPid,
      containerIdentity: identity,
    });
  }
  throw new Error("minio_restart_evidence_stale");
}

export function assertMinioRestartEvidence(evidence) {
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    evidence.schemaVersion !==
      "workload-funnel.minio-server-process-restart.v1" ||
    !/^[a-f0-9]{12,64}$/u.test(evidence.containerIdentity ?? "") ||
    !positiveSafeInteger(evidence.containerBoundaryPid) ||
    !positiveSafeInteger(evidence.supervisorPid) ||
    !positiveSafeInteger(evidence.previousServerGeneration) ||
    evidence.currentServerGeneration !==
      evidence.previousServerGeneration + 1 ||
    !positiveSafeInteger(evidence.previousServerPid) ||
    !positiveSafeInteger(evidence.currentServerPid) ||
    evidence.currentServerPid === evidence.previousServerPid ||
    evidence.containerBoundaryStable !== true ||
    evidence.containerIdentityStable !== true ||
    evidence.supervisorBoundaryStable !== true ||
    evidence.serverProcessGenerationChanged !== true ||
    evidence.serverProcessPidChanged !== true ||
    evidence.readinessAfterRestart !== true ||
    evidence.containerConfinementStable !== true ||
    !/^[a-f0-9]{64}$/u.test(evidence.configurationSha256 ?? "")
  )
    throw new Error("minio_restart_evidence_malformed");
  return Object.freeze(evidence);
}

export async function restartConfinedMinio({
  beforeConfinement,
  docker,
  identity,
  inspectConfinement,
  name,
  ready,
  waitFor,
}) {
  if (
    beforeConfinement?.exactIdentity !== identity ||
    typeof beforeConfinement?.configurationSha256 !== "string"
  )
    throw new Error("minio_restart_precondition_unproven");
  const processRestart = await docker.restartMinioServerProcess(name, identity);
  await waitFor(ready, "object_fixture_restart_timeout");
  const afterConfinement = await inspectConfinement();
  if (
    afterConfinement?.exactIdentity !== identity ||
    afterConfinement.configurationSha256 !==
      beforeConfinement.configurationSha256 ||
    afterConfinement.internalNetwork !== beforeConfinement.internalNetwork ||
    afterConfinement.internalNetworkEndpoint?.ipv4Address !==
      beforeConfinement.internalNetworkEndpoint?.ipv4Address ||
    afterConfinement.internalNetworkEndpoint?.port !==
      beforeConfinement.internalNetworkEndpoint?.port
  )
    throw new Error("minio_restart_confinement_changed");
  return assertMinioRestartEvidence({
    ...processRestart,
    configurationSha256: afterConfinement.configurationSha256,
    containerConfinementStable: true,
    readinessAfterRestart: true,
    schemaVersion: "workload-funnel.minio-server-process-restart.v1",
  });
}
