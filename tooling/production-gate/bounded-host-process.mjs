import { rm, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";

const OBSERVATION_WINDOW_TIMEOUT_MS = 4_000;
const DEFAULT_RUNTIME_MAX_SEC = 30;
const PRESSURE_RUNTIME_MAX_SEC_RANGE = Object.freeze({
  maximum: 90,
  minimum: 60,
});
const PRESSURE_ROLES = new Set([
  "pressure-cpu",
  "pressure-disk",
  "pressure-inodes",
  "pressure-io",
  "pressure-memory",
]);
const observationWindowScript = fileURLToPath(
  new URL("./fixtures/systemd-observation-window.mjs", import.meta.url),
);

function unitAbsent(result) {
  const loadStates = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("LoadState="));
  return (
    (loadStates.length === 1 && loadStates[0] === "LoadState=not-found") ||
    (result.code !== 0 &&
      /(?:could not be found|not found|not loaded)/iu.test(result.stderr))
  );
}

function unitInactiveOrAbsent(result) {
  return (
    unitAbsent(result) ||
    (result.code === 0 &&
      result.stdout.includes("ActiveState=inactive") &&
      result.stdout.includes("ControlGroup=\n"))
  );
}

async function showUnit(config, unit, properties) {
  return config.runner.run(
    config.systemctlExecutable,
    ["show", unit, `--property=${properties.join(",")}`, "--no-pager"],
    { timeoutMs: 2_000 },
  );
}

function parseShow(output) {
  const values = {};
  for (const line of output.trim().split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || Object.hasOwn(values, key))
      throw new Error("bounded_host_process_show_malformed");
    values[key] = line.slice(index + 1);
  }
  return values;
}

function systemdInteger(value) {
  const units = Object.freeze({
    "": 1n,
    G: 1024n * 1024n * 1024n,
    K: 1024n,
    M: 1024n * 1024n,
    ms: 1_000n,
    s: 1_000_000n,
    us: 1n,
  });
  const match = value?.match(/^(\d+)([A-Za-z]+)?$/u);
  const multiplier = units[match?.[2] ?? ""];
  if (match === null || match === undefined || multiplier === undefined)
    throw new Error("bounded_host_process_property_malformed");
  return BigInt(match[1]) * multiplier;
}

function sameWords(value, expected) {
  const observed = new Set(value?.trim().split(/\s+/u).filter(Boolean));
  return (
    observed.size === expected.length &&
    expected.every((word) => observed.has(word))
  );
}

function exactExecStopPostObserved(value, observationWindow) {
  if (observationWindow === undefined) return (value ?? "") === "";
  const prefix = `{ path=${observationWindow.nodeExecutable} ; argv[]=${[
    observationWindow.nodeExecutable,
    observationWindow.script,
    observationWindow.marker,
    String(OBSERVATION_WINDOW_TIMEOUT_MS),
  ].join(" ")} ; ignore_errors=no ;`;
  return (
    typeof value === "string" &&
    value.startsWith(prefix) &&
    value.indexOf("{ path=", prefix.length) === -1
  );
}

export function exactBoundedHostPropertiesObserved(
  values,
  config,
  plan,
  joinNetworkOf,
  requireControlGroup = true,
) {
  const exact = Object.freeze({
    AmbientCapabilities: "",
    CapabilityBoundingSet: "",
    CPUWeight: "100",
    Description: plan.description,
    DevicePolicy: "closed",
    Group: config.workloadGroup,
    IOWeight: "100",
    KillMode: "control-group",
    LimitFSIZE: "67108864",
    LimitNOFILE: "1024",
    LoadState: "loaded",
    LockPersonality: "yes",
    NoNewPrivileges: "yes",
    PrivateDevices: "yes",
    PrivateNetwork: "yes",
    PrivateTmp: "yes",
    ProcSubset: "pid",
    ProtectClock: "yes",
    ProtectControlGroups: "yes",
    ProtectHome: "yes",
    ProtectHostname: "yes",
    ProtectKernelLogs: "yes",
    ProtectKernelModules: "yes",
    ProtectKernelTunables: "yes",
    ProtectProc: "invisible",
    ProtectSystem: "strict",
    ReadWritePaths: config.workloadRoot,
    RestrictNamespaces: "yes",
    RestrictRealtime: "yes",
    RestrictSUIDSGID: "yes",
    SendSIGKILL: "yes",
    Slice: `${config.runId}.slice`,
    SystemCallArchitectures: "native",
    TasksMax: "128",
    UMask: "0077",
    User: config.workloadUser,
    WorkingDirectory: config.workloadRoot,
  });
  const read = values.IOReadBandwidthMax?.split(/\s+/u);
  const write = values.IOWriteBandwidthMax?.split(/\s+/u);
  if (
    Object.entries(exact).some(([key, expected]) => values[key] !== expected) ||
    values.Environment !==
      "HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC" ||
    !/^[a-f0-9]{32}$/u.test(values.InvocationID ?? "") ||
    (requireControlGroup &&
      !new Set(
        plan.observationWindow === undefined
          ? ["active"]
          : ["active", "deactivating"],
      ).has(values.ActiveState)) ||
    (requireControlGroup &&
      !/^\/[A-Za-z0-9_./-]+$/u.test(values.ControlGroup ?? "")) ||
    systemdInteger(values.CPUQuotaPerSecUSec) !== 1_000_000n ||
    systemdInteger(values.IOReadBandwidthMax?.split(/\s+/u)[1]) !==
      16_777_216n ||
    systemdInteger(values.IOWriteBandwidthMax?.split(/\s+/u)[1]) !==
      8_388_608n ||
    read?.[0] !== config.ioDevice ||
    write?.[0] !== config.ioDevice ||
    systemdInteger(values.MemoryHigh) !== 402_653_184n ||
    systemdInteger(values.MemoryMax) !== 536_870_912n ||
    systemdInteger(values.MemorySwapMax) !== 0n ||
    systemdInteger(values.RuntimeMaxUSec) !==
      BigInt(plan.runtimeMaxSec ?? DEFAULT_RUNTIME_MAX_SEC) * 1_000_000n ||
    systemdInteger(values.TimeoutStopUSec) !== 5_000_000n ||
    !new Set(["9", "SIGKILL", "kill"]).has(values.FinalKillSignal) ||
    !new Set(["15", "SIGTERM", "term"]).has(values.KillSignal) ||
    !sameWords(values.RestrictAddressFamilies, [
      "AF_UNIX",
      "AF_INET",
      "AF_INET6",
    ]) ||
    typeof values.SystemCallFilter !== "string" ||
    values.SystemCallFilter.length === 0 ||
    !exactExecStopPostObserved(values.ExecStopPost, plan.observationWindow) ||
    (joinNetworkOf === undefined
      ? (values.JoinsNamespaceOf ?? "") !== ""
      : !sameWords(values.JoinsNamespaceOf, [joinNetworkOf]))
  )
    throw new Error("bounded_host_process_confinement_unproven");
  return true;
}

export async function cleanupBoundedSystemdUnit(config, record) {
  const before = await showUnit(config, record.name, [
    "Description",
    "InvocationID",
    "LoadState",
  ]);
  if (unitAbsent(before)) return;
  if (before.code !== 0)
    throw new Error("bounded_host_process_cleanup_uncertain");
  const values = parseShow(before.stdout);
  if (
    values.LoadState !== "loaded" ||
    values.Description !== record.expected.description ||
    (record.observed.invocationId !== undefined &&
      values.InvocationID !== record.observed.invocationId)
  )
    throw new Error("bounded_host_process_cleanup_identity_changed");
  const stopped = await config.runner.run(
    config.systemctlExecutable,
    ["stop", record.name],
    { timeoutMs: 2_000 },
  );
  if (stopped.code !== 0)
    throw new Error("bounded_host_process_cleanup_uncertain");
  const reset = await config.runner.run(
    config.systemctlExecutable,
    ["reset-failed", record.name],
    { timeoutMs: 2_000 },
  );
  const after = await showUnit(config, record.name, [
    "ActiveState",
    "ControlGroup",
    "LoadState",
  ]);
  if ((reset.code !== 0 && !unitAbsent(after)) || !unitInactiveOrAbsent(after))
    throw new Error("bounded_host_process_cleanup_uncertain");
}

export function boundedHostSystemdArguments(config, input) {
  const runtimeMaxSec = input.runtimeMaxSec ?? DEFAULT_RUNTIME_MAX_SEC;
  if (
    !/^[a-z0-9-]{1,24}$/u.test(input.role) ||
    config.workloadUser !== "workload-funnel-synthetic" ||
    config.workloadGroup !== "workload-funnel-synthetic" ||
    config.workloadRoot !==
      `/var/lib/workload-funnel/allocations/${config.runId}` ||
    !/^\/dev\/[A-Za-z0-9._-]+$/u.test(config.ioDevice) ||
    !config.allowedExecutables.has(input.executable) ||
    !input.executable.startsWith("/") ||
    (input.joinNetworkOf !== undefined &&
      input.joinNetworkOf !== `${config.runId}-hq-server.service`) ||
    input.executableArguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    ) ||
    (input.observationWindow !== undefined &&
      (input.observationWindow.nodeExecutable !== config.nodeExecutable ||
        input.observationWindow.script !== observationWindowScript ||
        input.observationWindow.marker !==
          `${config.workloadRoot}/.observed-${input.role}`)) ||
    !Number.isSafeInteger(runtimeMaxSec) ||
    (input.runtimeMaxSec === undefined
      ? runtimeMaxSec !== DEFAULT_RUNTIME_MAX_SEC
      : !PRESSURE_ROLES.has(input.role) ||
        runtimeMaxSec < PRESSURE_RUNTIME_MAX_SEC_RANGE.minimum ||
        runtimeMaxSec > PRESSURE_RUNTIME_MAX_SEC_RANGE.maximum)
  )
    throw new Error("bounded_host_process_invocation_invalid");
  const unit = `${config.runId}-${input.role}.service`;
  const description = `WorkloadFunnel production gate ${config.runId} ${input.role}`;
  return Object.freeze({
    arguments: Object.freeze([
      `--unit=${unit}`,
      `--slice=${config.runId}.slice`,
      `--description=${description}`,
      "--collect",
      "--quiet",
      "--setenv=HOME=/nonexistent",
      "--setenv=LANG=C.UTF-8",
      "--setenv=LC_ALL=C.UTF-8",
      "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "--setenv=TZ=UTC",
      "--property=AmbientCapabilities=",
      "--property=CapabilityBoundingSet=",
      "--property=CPUQuota=100%",
      "--property=CPUWeight=100",
      "--property=DevicePolicy=closed",
      ...(input.observationWindow === undefined
        ? []
        : [
            `--property=ExecStopPost=${input.observationWindow.nodeExecutable} ${input.observationWindow.script} ${input.observationWindow.marker} ${String(OBSERVATION_WINDOW_TIMEOUT_MS)}`,
          ]),
      "--property=FinalKillSignal=SIGKILL",
      `--property=Group=${config.workloadGroup}`,
      "--property=IOWeight=100",
      `--property=IOReadBandwidthMax=${config.ioDevice} 16777216`,
      `--property=IOWriteBandwidthMax=${config.ioDevice} 8388608`,
      "--property=KillMode=control-group",
      "--property=KillSignal=SIGTERM",
      "--property=LimitFSIZE=67108864",
      "--property=LimitNOFILE=1024",
      "--property=LockPersonality=yes",
      "--property=MemoryHigh=402653184",
      "--property=MemoryMax=536870912",
      "--property=MemorySwapMax=0",
      "--property=NoNewPrivileges=yes",
      "--property=PrivateDevices=yes",
      "--property=PrivateNetwork=yes",
      "--property=PrivateTmp=yes",
      "--property=ProcSubset=pid",
      "--property=ProtectClock=yes",
      "--property=ProtectControlGroups=yes",
      "--property=ProtectHome=yes",
      "--property=ProtectHostname=yes",
      "--property=ProtectKernelLogs=yes",
      "--property=ProtectKernelModules=yes",
      "--property=ProtectKernelTunables=yes",
      "--property=ProtectProc=invisible",
      "--property=ProtectSystem=strict",
      `--property=ReadWritePaths=${config.workloadRoot}`,
      "--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "--property=RestrictNamespaces=yes",
      "--property=RestrictRealtime=yes",
      "--property=RestrictSUIDSGID=yes",
      `--property=RuntimeMaxSec=${String(runtimeMaxSec)}s`,
      "--property=SendSIGKILL=yes",
      "--property=SystemCallArchitectures=native",
      "--property=SystemCallFilter=@system-service ~@mount ~@privileged ~@resources ~@reboot",
      "--property=TasksMax=128",
      "--property=TimeoutStopSec=5s",
      "--property=UMask=0077",
      `--property=User=${config.workloadUser}`,
      `--property=WorkingDirectory=${config.workloadRoot}`,
      ...(input.joinNetworkOf === undefined
        ? []
        : [`--property=JoinsNamespaceOf=${input.joinNetworkOf}`]),
      "--",
      input.executable,
      ...input.executableArguments,
    ]),
    description,
    joinNetworkOf: input.joinNetworkOf,
    observationWindow: input.observationWindow,
    runtimeMaxSec,
    unit,
  });
}

export function createBoundedHostProcessManager(config) {
  const units = new Map();
  const cancellations = new Map();
  const observeStarted = async (
    plan,
    requireControlGroup = true,
    retryAbsent = false,
  ) => {
    const properties = [
      "ActiveState",
      "ControlGroup",
      "AmbientCapabilities",
      "CapabilityBoundingSet",
      "CPUQuotaPerSecUSec",
      "CPUWeight",
      "Description",
      "DevicePolicy",
      "Environment",
      "ExecStopPost",
      "FinalKillSignal",
      "Group",
      "IOReadBandwidthMax",
      "IOWeight",
      "IOWriteBandwidthMax",
      "InvocationID",
      "JoinsNamespaceOf",
      "KillMode",
      "KillSignal",
      "LimitFSIZE",
      "LimitNOFILE",
      "LoadState",
      "LockPersonality",
      "MemoryHigh",
      "MemoryMax",
      "MemorySwapMax",
      "NoNewPrivileges",
      "PrivateDevices",
      "PrivateNetwork",
      "PrivateTmp",
      "ProcSubset",
      "ProtectClock",
      "ProtectControlGroups",
      "ProtectHome",
      "ProtectHostname",
      "ProtectKernelLogs",
      "ProtectKernelModules",
      "ProtectKernelTunables",
      "ProtectProc",
      "ProtectSystem",
      "ReadWritePaths",
      "RestrictAddressFamilies",
      "RestrictNamespaces",
      "RestrictRealtime",
      "RestrictSUIDSGID",
      "RuntimeMaxUSec",
      "SendSIGKILL",
      "Slice",
      "SystemCallArchitectures",
      "SystemCallFilter",
      "TasksMax",
      "TimeoutStopUSec",
      "UMask",
      "User",
      "WorkingDirectory",
    ];
    const deadline = Date.now() + 1_000;
    for (;;) {
      const observed = await showUnit(config, plan.unit, properties);
      if (retryAbsent && unitAbsent(observed) && Date.now() < deadline) {
        await wait(10);
        continue;
      }
      if (observed.code !== 0 || unitAbsent(observed))
        throw new Error("bounded_host_process_identity_unproven");
      const values = parseShow(observed.stdout);
      exactBoundedHostPropertiesObserved(
        values,
        config,
        plan,
        plan.joinNetworkOf,
        requireControlGroup,
      );
      return values;
    }
  };
  const finalize = async (recordId, plan, values) => {
    const record = Object.freeze({
      expected: { description: plan.description },
      name: plan.unit,
      observed: { invocationId: values.InvocationID },
    });
    await config.ledger.finalize(recordId, record.observed, () =>
      cleanupBoundedSystemdUnit(config, record),
    );
    await config.sliceOwnership.register();
    return record;
  };
  const assertOwnedActive = async (process, code) => {
    const expected = units.get(process.role);
    if (
      expected === undefined ||
      expected.unit !== process.unit ||
      expected.invocationId !== process.invocationId ||
      expected.controlGroup !== process.controlGroup ||
      expected.description !== process.description ||
      expected.runtimeMaxSec !== process.runtimeMaxSec
    )
      throw new Error("bounded_host_process_not_owned");
    const observed = await showUnit(config, process.unit, [
      "ActiveState",
      "ControlGroup",
      "Description",
      "InvocationID",
      "LoadState",
      "RuntimeMaxUSec",
    ]);
    if (observed.code !== 0 || unitAbsent(observed)) throw new Error(code);
    const values = parseShow(observed.stdout);
    if (
      values.ActiveState !== "active" ||
      values.ControlGroup !== process.controlGroup ||
      values.Description !== process.description ||
      values.InvocationID !== process.invocationId ||
      values.LoadState !== "loaded" ||
      systemdInteger(values.RuntimeMaxUSec) !==
        BigInt(process.runtimeMaxSec) * 1_000_000n
    )
      throw new Error(code);
    return Object.freeze({
      active: true,
      controlGroup: process.controlGroup,
      invocationId: process.invocationId,
      runtimeMaxSec: process.runtimeMaxSec,
      unit: process.unit,
    });
  };
  return Object.freeze({
    async execute(executable, executableArguments, role, options = {}) {
      await config.reviewedExecutables.assertUnchanged(executable);
      await config.reviewedExecutables.assertUnchanged(config.nodeExecutable);
      const observationMarker = `${config.workloadRoot}/.observed-${role}`;
      const plan = boundedHostSystemdArguments(config, {
        executable,
        executableArguments,
        joinNetworkOf: options.joinNetworkOf,
        observationWindow: {
          marker: observationMarker,
          nodeExecutable: config.nodeExecutable,
          script: observationWindowScript,
        },
        role,
      });
      const recordId = await config.ledger.prepare("systemd-unit", plan.unit, {
        description: plan.description,
      });
      await config.sliceOwnership.admit();
      const marker = plan.arguments.indexOf("--");
      const args = [
        ...plan.arguments.slice(0, marker),
        "--wait",
        "--pipe",
        ...plan.arguments.slice(marker),
      ];
      let execution;
      let record = Object.freeze({
        expected: { description: plan.description },
        name: plan.unit,
        observed: {},
      });
      let result;
      let failure;
      let markerReleased = false;
      try {
        execution = await config.runner.start(
          config.systemdRunExecutable,
          args,
          options.limits,
        );
        const values = await observeStarted(plan, true, true);
        record = await finalize(recordId, plan, values);
        const durableValues = await observeStarted(plan);
        if (durableValues.InvocationID !== values.InvocationID)
          throw new Error("bounded_host_process_identity_changed");
        await (config.writeObservationMarker ?? writeFile)(
          observationMarker,
          "",
          { flag: "wx", mode: 0o400 },
        );
        markerReleased = true;
        result = await execution.completion;
      } catch (error) {
        failure = error;
      }
      if (failure !== undefined && execution !== undefined) {
        execution.kill();
        await execution.completion;
      }
      let cleanupFailure;
      if (execution !== undefined) {
        try {
          await cleanupBoundedSystemdUnit(config, record);
        } catch (error) {
          cleanupFailure = error;
        }
      }
      if (markerReleased) {
        try {
          await (config.removeObservationMarker ?? rm)(observationMarker, {
            force: true,
          });
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
      if (cleanupFailure !== undefined) throw cleanupFailure;
      if (failure !== undefined) throw failure;
      return result;
    },
    async start(executable, executableArguments, role, options = {}) {
      if (units.has(role) || units.size >= 64)
        throw new Error("bounded_host_process_role_invalid");
      await config.reviewedExecutables.assertUnchanged(executable);
      const plan = boundedHostSystemdArguments(config, {
        executable,
        executableArguments,
        joinNetworkOf: options.joinNetworkOf,
        role,
      });
      const recordId = await config.ledger.prepare("systemd-unit", plan.unit, {
        description: plan.description,
      });
      await config.sliceOwnership.admit();
      const result = await config.runner.run(
        config.systemdRunExecutable,
        plan.arguments,
        { timeoutMs: 10_000 },
      );
      if (result.code !== 0)
        throw new Error("bounded_host_process_start_failed");
      const values = await observeStarted(plan);
      await finalize(recordId, plan, values);
      const process = Object.freeze({
        controlGroup: values.ControlGroup,
        description: plan.description,
        invocationId: values.InvocationID,
        role,
        runtimeMaxSec: plan.runtimeMaxSec,
        unit: plan.unit,
      });
      units.set(role, process);
      return process;
    },
    async cancel(process) {
      const expected = units.get(process.role);
      if (
        expected === undefined ||
        expected.unit !== process.unit ||
        expected.invocationId !== process.invocationId ||
        expected.controlGroup !== process.controlGroup
      )
        throw new Error("bounded_host_process_not_owned");
      const prior = cancellations.get(process.role);
      if (prior === undefined) {
        await assertOwnedActive(
          process,
          "bounded_host_process_cancel_identity_unproven",
        );
        const stopped = await config.runner.run(
          config.systemctlExecutable,
          ["stop", process.unit],
          { timeoutMs: 2_000 },
        );
        if (stopped.code !== 0)
          throw new Error("bounded_host_process_stop_uncertain");
        const after = await showUnit(config, process.unit, [
          "ActiveState",
          "ControlGroup",
          "LoadState",
        ]);
        if (!unitInactiveOrAbsent(after))
          throw new Error("bounded_host_process_stop_uncertain");
        const evidence = Object.freeze({
          cancellationObserved: true,
          confinedCancellationPerformed: true,
          controlGroup: process.controlGroup,
          invocationId: process.invocationId,
          killMode: "control-group",
          unit: process.unit,
        });
        cancellations.set(process.role, evidence);
        return evidence;
      }
      const observed = await showUnit(config, process.unit, [
        "ActiveState",
        "ControlGroup",
        "LoadState",
      ]);
      if (!unitInactiveOrAbsent(observed))
        throw new Error("bounded_host_process_cancellation_regressed");
      return Object.freeze({
        ...prior,
        confinedCancellationPerformed: false,
      });
    },
    verify(process) {
      return assertOwnedActive(
        process,
        "bounded_host_process_identity_unproven",
      );
    },
    async stop(process) {
      await assertOwnedActive(
        process,
        "bounded_host_process_stop_identity_unproven",
      );
      const result = await config.runner.run(
        config.systemctlExecutable,
        ["stop", process.unit],
        { timeoutMs: 2_000 },
      );
      if (result.code !== 0)
        throw new Error("bounded_host_process_stop_uncertain");
      const after = await showUnit(config, process.unit, [
        "ActiveState",
        "ControlGroup",
        "LoadState",
      ]);
      if (!unitInactiveOrAbsent(after))
        throw new Error("bounded_host_process_stop_uncertain");
      units.delete(process.role);
      cancellations.delete(process.role);
    },
  });
}
