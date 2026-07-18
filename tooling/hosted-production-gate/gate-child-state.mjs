import { Buffer } from "node:buffer";
import { readFile, readdir, realpath } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

import { HostedGateRefusal, sha256 } from "./contract.mjs";
import { runCommand } from "./process-runner.mjs";
import { readHostState, saveHostState } from "./host-state.mjs";

const INVOCATIONS = new Set(["cleanup-1", "cleanup-2", "gate"]);

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

export function gateChildPlan(context, invocation) {
  refuse(!INVOCATIONS.has(invocation), "gate_child_invocation_invalid");
  return Object.freeze({
    id: invocation,
    marker: sha256(
      Buffer.from(`${context.runId}\0${invocation}\0hosted-gate-child`, "utf8"),
    ),
    status: "planned",
    unit: `${context.runId}-${invocation}.service`,
  });
}

export async function planGateChild(state, invocation) {
  const planned = gateChildPlan(state.context, invocation);
  const existing = state.gateInvocations.find((item) => item.id === invocation);
  if (existing !== undefined) {
    refuse(
      existing.marker !== planned.marker || existing.unit !== planned.unit,
      "gate_child_plan_conflict",
    );
    return existing;
  }
  state.gateInvocations.push(planned);
  await saveHostState(state);
  return planned;
}

function parseStarttime(stat) {
  const close = stat.lastIndexOf(")");
  const fields =
    close < 0
      ? []
      : stat
          .slice(close + 1)
          .trim()
          .split(/\s+/u);
  const starttime = fields[19];
  refuse(!/^[1-9][0-9]*$/u.test(starttime ?? ""), "gate_child_stat_invalid");
  return starttime;
}

export async function readGateChildIdentity(pid) {
  refuse(!Number.isSafeInteger(pid) || pid < 2, "gate_child_pid_invalid");
  try {
    const [cgroup, executable, stat] = await Promise.all([
      readFile(`/proc/${pid}/cgroup`, "utf8"),
      realpath(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    return Object.freeze({
      cgroup: cgroup.trim(),
      executable,
      pid,
      starttime: parseStarttime(stat),
    });
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function startGateChild(context, invocation, identity) {
  const state = await readHostState(context);
  const index = state.gateInvocations.findIndex(
    (item) => item.id === invocation,
  );
  refuse(index < 0, "gate_child_plan_missing");
  const current = state.gateInvocations[index];
  refuse(
    current.status !== "planned" ||
      identity.executable !== state.executables?.node ||
      !identity.cgroup.includes(current.unit),
    "gate_child_identity_invalid",
  );
  state.gateInvocations[index] = {
    ...current,
    ...identity,
    status: "started",
  };
  await saveHostState(state);
  return state.gateInvocations[index];
}

export async function finishGateChild(
  state,
  invocation,
  { exitCode, outcome = "completed" },
) {
  const index = state.gateInvocations.findIndex(
    (item) => item.id === invocation,
  );
  refuse(index < 0, "gate_child_plan_missing");
  const current = state.gateInvocations[index];
  if (current.status === "finished") return current;
  refuse(
    (current.status === "planned" && outcome !== "never-spawned") ||
      (current.status === "started" && outcome === "never-spawned") ||
      !Number.isSafeInteger(exitCode) ||
      exitCode < 0 ||
      exitCode > 255,
    "gate_child_transition_invalid",
  );
  state.gateInvocations[index] = {
    ...current,
    exitCode,
    outcome,
    status: "finished",
  };
  await saveHostState(state);
  return state.gateInvocations[index];
}

function parseSystemdShow(output) {
  const values = {};
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0)
      values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function unitDescription(invocation) {
  return `workload-funnel-hosted-gate:${invocation.marker}`;
}

function validateLoadedUnit(invocation, observed) {
  refuse(
    observed.LoadState !== "loaded" ||
      observed.CollectMode !== "inactive-or-failed" ||
      observed.Description !== unitDescription(invocation),
    "gate_child_unit_identity_changed",
  );
}

async function showUnit(state, invocation, command = runCommand) {
  const result = await command(state.executables.systemctl, [
    "show",
    invocation.unit,
    "--property=ActiveState,CollectMode,ControlGroup,Description,LoadState,MainPID",
    "--no-pager",
  ]);
  refuse(result.code !== 0, "gate_child_unit_probe_failed");
  return parseSystemdShow(result.stdout);
}

async function markerProcesses(
  marker,
  {
    list = readdir,
    read = readFile,
    readIdentity = readGateChildIdentity,
  } = {},
) {
  const matches = [];
  for (const entry of await list("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    try {
      const environment = await read(`/proc/${entry.name}/environ`);
      if (
        environment
          .toString("utf8")
          .split("\0")
          .includes(`WF_HOSTED_GATE_CHILD_MARKER=${marker}`)
      ) {
        const identity = await readIdentity(Number(entry.name));
        if (identity !== undefined) matches.push(identity);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return matches;
}

async function releaseFinishedUnit(
  state,
  invocation,
  { command = runCommand, pause = wait, show = showUnit } = {},
) {
  const observed = await show(state, invocation, command);
  if (observed.LoadState === "not-found") return;
  validateLoadedUnit(invocation, observed);
  refuse(
    observed.MainPID !== "0" ||
      !new Set(["failed", "inactive"]).has(observed.ActiveState),
    "gate_child_finished_unit_active",
  );
  const reset = await command(state.executables.systemctl, [
    "reset-failed",
    invocation.unit,
  ]);
  if (reset.code !== 0) {
    const raced = await show(state, invocation, command);
    if (raced.LoadState === "not-found") return;
    validateLoadedUnit(invocation, raced);
    throw new HostedGateRefusal("gate_child_unit_release_failed");
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const released = await show(state, invocation, command);
    if (released.LoadState === "not-found") return;
    await pause(100);
  }
  throw new HostedGateRefusal("gate_child_unit_release_failed");
}

export async function recoverGateChild(state, invocationId, dependencies = {}) {
  const command = dependencies.command ?? runCommand;
  const markers = dependencies.markers ?? markerProcesses;
  const pause = dependencies.pause ?? wait;
  const readIdentity = dependencies.readIdentity ?? readGateChildIdentity;
  const show = dependencies.show ?? showUnit;
  const release = (finished) =>
    releaseFinishedUnit(state, finished, { command, pause, show });
  let invocation = state.gateInvocations.find(
    (item) => item.id === invocationId,
  );
  if (invocation === undefined) return;
  if (invocation.status === "finished") {
    await release(invocation);
    return;
  }
  const unit = await show(state, invocation, command);
  const unitAbsent = unit.LoadState === "not-found";
  if (!unitAbsent) validateLoadedUnit(invocation, unit);
  if (invocation.status === "planned") {
    const matches = await markers(invocation.marker, { readIdentity });
    refuse(matches.length > 1, "gate_child_identity_ambiguous");
    const neverStartedUnit =
      unit.LoadState === "loaded" &&
      unit.MainPID === "0" &&
      new Set(["failed", "inactive"]).has(unit.ActiveState);
    if (matches.length === 0 && (unitAbsent || neverStartedUnit)) {
      await finishGateChild(state, invocation.id, {
        exitCode: 0,
        outcome: "never-spawned",
      });
      if (!unitAbsent)
        await release(
          state.gateInvocations.find((item) => item.id === invocation.id),
        );
      return;
    }
    refuse(matches.length !== 1, "gate_child_started_identity_missing");
    refuse(
      unit.LoadState !== "loaded" ||
        !new Set(["active", "activating"]).has(unit.ActiveState) ||
        unit.MainPID !== String(matches[0].pid) ||
        unit.ControlGroup === "" ||
        !matches[0].cgroup.includes(unit.ControlGroup),
      "gate_child_identity_changed",
    );
    await startGateChild(state.context, invocation.id, matches[0]);
    Object.assign(state, await readHostState(state.context));
    invocation = state.gateInvocations.find((item) => item.id === invocationId);
  }
  const observed = await readIdentity(invocation.pid);
  if (observed === undefined) {
    refuse(
      !unitAbsent &&
        unit.ActiveState !== "inactive" &&
        unit.ActiveState !== "failed",
      "gate_child_unit_still_active",
    );
    await finishGateChild(state, invocation.id, {
      exitCode: 255,
      outcome: "recovered-absent",
    });
    await release(
      state.gateInvocations.find((item) => item.id === invocation.id),
    );
    return;
  }
  refuse(
    observed.pid !== invocation.pid ||
      observed.starttime !== invocation.starttime ||
      observed.executable !== invocation.executable ||
      observed.cgroup !== invocation.cgroup ||
      unit.MainPID !== String(invocation.pid) ||
      unit.ControlGroup === "" ||
      !invocation.cgroup.includes(unit.ControlGroup),
    "gate_child_identity_changed",
  );
  const stopped = await command(state.executables.systemctl, [
    "stop",
    invocation.unit,
  ]);
  refuse(stopped.code !== 0, "gate_child_stop_failed");
  refuse(
    (await readIdentity(invocation.pid)) !== undefined,
    "gate_child_stop_unproven",
  );
  await finishGateChild(state, invocation.id, {
    exitCode: 137,
    outcome: "recovered-killed",
  });
  await release(
    state.gateInvocations.find((item) => item.id === invocation.id),
  );
}
