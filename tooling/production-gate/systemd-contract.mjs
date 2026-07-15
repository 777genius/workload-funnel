import { OWNED_NAME_PATTERN } from "./constants.mjs";

const servicePattern =
  /^(wf-production-gate-[a-f0-9]{32})-[a-z0-9-]{1,32}\.service$/u;
const slicePattern = /^wf-production-gate-[a-f0-9]{32}\.slice$/u;

function yesNo(value) {
  if (value !== true && value !== false)
    throw new Error("systemd_property_not_boolean");
  return value ? "yes" : "no";
}

function microseconds(value) {
  if (typeof value !== "bigint" || value <= 0n)
    throw new Error("systemd_duration_invalid");
  return `${String(value)}us`;
}

function bytes(value, allowInfinity = false) {
  if (allowInfinity && value === "infinity") return "infinity";
  if (typeof value !== "bigint" || value < 0n)
    throw new Error("systemd_bytes_invalid");
  return String(value);
}

export function systemdPropertyAssignments(properties, ioDevice) {
  if (!/^\/dev\/[A-Za-z0-9._-]+$/u.test(ioDevice))
    throw new Error("unsafe_systemd_io_device");
  if (
    properties.KillMode !== "control-group" ||
    properties.NoNewPrivileges !== true ||
    properties.ProtectSystem !== "strict" ||
    properties.ProtectControlGroups !== true ||
    properties.ProtectKernelModules !== true ||
    properties.ProtectKernelTunables !== true ||
    properties.PrivateDevices !== true ||
    properties.PrivateTmp !== true ||
    properties.DevicePolicy !== "closed" ||
    !Array.isArray(properties.AmbientCapabilities) ||
    properties.AmbientCapabilities.length !== 0 ||
    !Array.isArray(properties.CapabilityBoundingSet) ||
    properties.CapabilityBoundingSet.length !== 0
  )
    throw new Error("systemd_gate_mapping_relaxed");
  const readLimit = properties.IOReadBandwidthMax.find(
    ([device]) => device === ioDevice,
  );
  const writeLimit = properties.IOWriteBandwidthMax.find(
    ([device]) => device === ioDevice,
  );
  if (readLimit === undefined || writeLimit === undefined)
    throw new Error("systemd_gate_io_mapping_missing");
  const assignments = [
    "AmbientCapabilities=",
    "CapabilityBoundingSet=",
    ...(properties.CPUQuotaPerSecUSec === undefined
      ? []
      : [`CPUQuotaPerSecUSec=${microseconds(properties.CPUQuotaPerSecUSec)}`]),
    `CPUWeight=${String(properties.CPUWeight)}`,
    `DevicePolicy=${properties.DevicePolicy}`,
    "FinalKillSignal=SIGKILL",
    `IOReadBandwidthMax=${readLimit[0]} ${String(readLimit[1])}`,
    `IOWeight=${String(properties.IOWeight)}`,
    `IOWriteBandwidthMax=${writeLimit[0]} ${String(writeLimit[1])}`,
    `KillMode=${properties.KillMode}`,
    "KillSignal=SIGTERM",
    `LimitNOFILE=${String(properties.LimitNOFILE)}`,
    `MemoryHigh=${bytes(properties.MemoryHigh)}`,
    `MemoryMax=${bytes(properties.MemoryMax)}`,
    `MemorySwapMax=${bytes(properties.MemorySwapMax, true)}`,
    `NoNewPrivileges=${yesNo(properties.NoNewPrivileges)}`,
    "LockPersonality=yes",
    `PrivateDevices=${yesNo(properties.PrivateDevices)}`,
    `PrivateNetwork=${yesNo(properties.PrivateNetwork)}`,
    `PrivateTmp=${yesNo(properties.PrivateTmp)}`,
    "ProcSubset=pid",
    "ProtectClock=yes",
    "ProtectHome=yes",
    "ProtectHostname=yes",
    "ProtectKernelLogs=yes",
    `ProtectControlGroups=${yesNo(properties.ProtectControlGroups)}`,
    `ProtectKernelModules=${yesNo(properties.ProtectKernelModules)}`,
    `ProtectKernelTunables=${yesNo(properties.ProtectKernelTunables)}`,
    `ProtectSystem=${properties.ProtectSystem}`,
    `ReadWritePaths=${properties.ReadWritePaths.join(" ")}`,
    `RuntimeMaxSec=${microseconds(properties.RuntimeMaxUSec)}`,
    "SendSIGKILL=yes",
    "RestrictAddressFamilies=AF_UNIX",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "RestrictSUIDSGID=yes",
    "SystemCallArchitectures=native",
    `SystemCallFilter=${properties.SystemCallFilter.join(" ")}`,
    `TasksMax=${String(properties.TasksMax)}`,
    "TimeoutStopSec=5s",
    "UMask=0077",
    `User=${properties.User}`,
    `Group=${properties.Group}`,
  ];
  return Object.freeze(assignments);
}

export function systemdRunArguments({
  description,
  executable,
  executableArguments = [],
  ioDevice,
  properties,
  slice,
  unit,
}) {
  const match = unit.match(servicePattern);
  if (
    match === null ||
    !slicePattern.test(slice) ||
    slice !== `${match[1]}.slice` ||
    !executable.startsWith("/") ||
    executable.includes("\u0000") ||
    executableArguments.some((argument) => argument.includes("\u0000")) ||
    typeof description !== "string" ||
    !description.startsWith("WorkloadFunnel production gate ") ||
    description.includes("\u0000")
  )
    throw new Error("unsafe_systemd_gate_invocation");
  return Object.freeze([
    `--unit=${unit}`,
    `--slice=${slice}`,
    `--description=${description}`,
    "--collect",
    "--quiet",
    "--setenv=HOME=/nonexistent",
    "--setenv=LANG=C.UTF-8",
    "--setenv=LC_ALL=C.UTF-8",
    "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--setenv=TZ=UTC",
    ...systemdPropertyAssignments(properties, ioDevice).map(
      (property) => `--property=${property}`,
    ),
    "--",
    executable,
    ...executableArguments,
  ]);
}

export function systemctlShowArguments(unit) {
  if (unit.match(servicePattern) === null)
    throw new Error("unsafe_systemd_gate_unit");
  return Object.freeze([
    "show",
    unit,
    "--no-pager",
    "--property=ActiveState,AmbientCapabilities,CapabilityBoundingSet,CPUQuotaPerSecUSec,CPUWeight,ControlGroup,Description,DevicePolicy,Environment,FinalKillSignal,Group,IOReadBandwidthMax,IOWeight,IOWriteBandwidthMax,InvocationID,KillMode,KillSignal,LimitNOFILE,LockPersonality,MemoryHigh,MemoryMax,MemorySwapMax,NoNewPrivileges,PrivateDevices,PrivateNetwork,PrivateTmp,ProcSubset,ProtectClock,ProtectControlGroups,ProtectHome,ProtectHostname,ProtectKernelLogs,ProtectKernelModules,ProtectKernelTunables,ProtectProc,ProtectSystem,ReadWritePaths,RestrictAddressFamilies,RestrictNamespaces,RestrictRealtime,RestrictSUIDSGID,Result,RuntimeMaxUSec,SendSIGKILL,Slice,SystemCallArchitectures,SystemCallFilter,TasksMax,TimeoutStopUSec,UMask,User",
  ]);
}

export function parseSystemctlShow(output) {
  const values = {};
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("systemd_show_malformed");
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key))
      throw new Error("systemd_show_duplicate_property");
    values[key] = line.slice(separator + 1);
  }
  return Object.freeze(values);
}

function systemdInteger(value, units = {}) {
  const match = value?.match(/^(\d+)([A-Za-z]+)?$/u);
  const multiplier = units[match?.[2] ?? ""];
  if (match === null || match === undefined || multiplier === undefined)
    throw new Error("systemd_property_value_malformed");
  return BigInt(match[1]) * multiplier;
}

export function exactSystemdPropertiesObserved(
  values,
  { description, ioDevice, properties, slice },
) {
  if (
    !slicePattern.test(slice) ||
    values.Slice !== slice ||
    values.Description !== description ||
    values.Environment !==
      "HOME=/nonexistent LANG=C.UTF-8 LC_ALL=C.UTF-8 PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TZ=UTC" ||
    !/^[a-f0-9]{32}$/u.test(values.InvocationID ?? "") ||
    !(values.ControlGroup ?? "").startsWith("/")
  )
    throw new Error("systemd_slice_mismatch");
  const required = Object.freeze({
    DevicePolicy: "closed",
    KillMode: "control-group",
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
    RestrictAddressFamilies: "AF_UNIX",
    RestrictNamespaces: "yes",
    RestrictRealtime: "yes",
    RestrictSUIDSGID: "yes",
    SystemCallArchitectures: "native",
    UMask: "0077",
  });
  if (Object.entries(required).some(([key, value]) => values[key] !== value))
    throw new Error("systemd_sandbox_property_mismatch");
  if (properties !== undefined) {
    const durations = { "": 1n, ms: 1_000n, s: 1_000_000n, us: 1n };
    const sizes = {
      "": 1n,
      G: 1024n * 1024n * 1024n,
      K: 1024n,
      M: 1024n * 1024n,
    };
    const read = values.IOReadBandwidthMax?.split(/\s+/u);
    const write = values.IOWriteBandwidthMax?.split(/\s+/u);
    const readExpected = properties.IOReadBandwidthMax.find(
      ([device]) => device === ioDevice,
    );
    const writeExpected = properties.IOWriteBandwidthMax.find(
      ([device]) => device === ioDevice,
    );
    if (
      values.AmbientCapabilities !== "" ||
      values.CapabilityBoundingSet !== "" ||
      values.CPUWeight !== String(properties.CPUWeight) ||
      systemdInteger(values.CPUQuotaPerSecUSec, durations) !==
        properties.CPUQuotaPerSecUSec ||
      !new Set(["9", "SIGKILL", "kill"]).has(values.FinalKillSignal) ||
      !new Set(["15", "SIGTERM", "term"]).has(values.KillSignal) ||
      values.Group !== properties.Group ||
      values.User !== properties.User ||
      values.LimitNOFILE !== String(properties.LimitNOFILE) ||
      systemdInteger(values.MemoryHigh, sizes) !== properties.MemoryHigh ||
      systemdInteger(values.MemoryMax, sizes) !== properties.MemoryMax ||
      systemdInteger(values.MemorySwapMax, sizes) !==
        properties.MemorySwapMax ||
      values.ReadWritePaths !== properties.ReadWritePaths.join(" ") ||
      systemdInteger(values.RuntimeMaxUSec, durations) !==
        properties.RuntimeMaxUSec ||
      values.SendSIGKILL !== "yes" ||
      values.TasksMax !== String(properties.TasksMax) ||
      systemdInteger(values.TimeoutStopUSec, durations) !== 5_000_000n ||
      values.IOWeight !== String(properties.IOWeight) ||
      readExpected === undefined ||
      writeExpected === undefined ||
      read?.[0] !== ioDevice ||
      write?.[0] !== ioDevice ||
      systemdInteger(read[1], sizes) !== readExpected[1] ||
      systemdInteger(write[1], sizes) !== writeExpected[1] ||
      typeof values.SystemCallFilter !== "string" ||
      values.SystemCallFilter.length === 0
    )
      throw new Error("systemd_mapped_property_mismatch");
  }
  return true;
}

export async function createMappedSystemdGatePlan({
  capabilityReport,
  ioDevice,
  runId,
}) {
  if (!OWNED_NAME_PATTERN.test(runId))
    throw new Error("unsafe_systemd_gate_run_id");
  const mapping =
    await import("@workload-funnel/executor-systemd/cgroup-resource-mapping");
  const base = mapping.createSyntheticSandboxProfile(runId);
  const profile = Object.freeze({
    ...base,
    resources: Object.freeze({
      ...base.resources,
      ephemeralStorage: Object.freeze({
        ...base.resources.ephemeralStorage,
        inodeMaximum: 4_096n,
        maximumBytes: 64n * 1024n * 1024n,
      }),
      io: Object.freeze({
        ...base.resources.io,
        devices: Object.freeze(
          base.resources.io.devices.map(() =>
            Object.freeze({
              device: ioDevice,
              readBytesPerSecond: 1_048_576n,
              writeBytesPerSecond: 524_288n,
            }),
          ),
        ),
      }),
      memory: Object.freeze({
        ...base.resources.memory,
        highBytes: 64n * 1024n * 1024n,
        maximumBytes: 96n * 1024n * 1024n,
      }),
      processLimit: 16,
      runtimeMaximumMicroseconds: 5_000_000n,
    }),
  });
  const decision = mapping.mapSystemdExecutionControls(
    profile,
    capabilityReport,
    "synthetic_disposable_linux_fixture",
  );
  if (decision.status !== "supported")
    throw new Error("systemd_required_capability_missing");
  return Object.freeze({
    ...decision,
    mappingEvidenceSource: capabilityReport.evidenceSource,
  });
}

async function waitFor(config, predicate, code, maximumMs = 10_000) {
  const deadline = config.clock() + maximumMs;
  for (;;) {
    const value = await predicate();
    if (value !== undefined) return value;
    if (config.clock() >= deadline) throw new Error(code);
    await config.wait(100);
  }
}

export async function runSystemdGateProbe(config) {
  const plan = await createMappedSystemdGatePlan({
    capabilityReport: config.capabilityReport,
    ioDevice: config.ioDevice,
    runId: config.runId,
  });
  const slice = `${config.runId}.slice`;
  const properties = plan.properties;
  const show = async (unit) => {
    const result = await config.runner.run(
      config.systemctlExecutable,
      systemctlShowArguments(unit),
      { timeoutMs: 2_000 },
    );
    return result.code === 0 ? parseSystemctlShow(result.stdout) : undefined;
  };
  const start = async (mode) => {
    await config.reviewedExecutables.assertUnchanged(config.nodeExecutable);
    const unit = `${config.runId}-${mode}.service`;
    const description = `WorkloadFunnel production gate ${config.runId} ${mode}`;
    await config.prepareUnit(unit, description);
    await config.sliceOwnership.admit();
    const result = await config.runner.run(
      config.systemdRunExecutable,
      systemdRunArguments({
        description,
        executable: config.nodeExecutable,
        executableArguments: [config.fixturePath, mode, plan.diskQuota.root],
        ioDevice: config.ioDevice,
        properties,
        slice,
        unit,
      }),
      { timeoutMs: 10_000 },
    );
    if (result.code !== 0) throw new Error(`systemd_${mode}_start_failed`);
    const started = {
      unit,
      values: await waitFor(
        config,
        () => show(unit),
        `systemd_${mode}_show_timeout`,
      ),
    };
    await config.finalizeUnit(unit, started.values);
    return started;
  };
  const stop = async (unit) => {
    const result = await config.runner.run(
      config.systemctlExecutable,
      ["stop", unit, "--no-block"],
      { timeoutMs: 2_000 },
    );
    if (result.code !== 0) throw new Error("systemd_gate_stop_failed");
    return waitFor(
      config,
      async () => {
        const values = await show(unit);
        return values?.ActiveState === "inactive" ||
          values?.ActiveState === "failed"
          ? values
          : undefined;
      },
      "systemd_gate_stop_timeout",
    );
  };

  const tree = await start("tree");
  exactSystemdPropertiesObserved(tree.values, {
    description: `WorkloadFunnel production gate ${config.runId} tree`,
    ioDevice: config.ioDevice,
    properties,
    slice,
  });
  const descendantPids = await config.readDescendantPids(plan.diskQuota.root);
  const cancelStarted = config.preciseClock();
  await stop(tree.unit);
  const cancelLatencyMs = config.preciseClock() - cancelStarted;
  if (descendantPids.some(config.pidExists))
    throw new Error("systemd_descendant_survived_control_group_stop");

  const memory = await start("memory");
  exactSystemdPropertiesObserved(memory.values, {
    description: `WorkloadFunnel production gate ${config.runId} memory`,
    ioDevice: config.ioDevice,
    properties,
    slice,
  });
  const memoryTerminal = await waitFor(
    config,
    async () => {
      const values = await show(memory.unit);
      return values?.ActiveState === "failed" ||
        values?.ActiveState === "inactive"
        ? values
        : undefined;
    },
    "systemd_memory_limit_timeout",
    10_000,
  );
  if (memoryTerminal.Result !== "oom-kill")
    throw new Error("systemd_memory_limit_unclassified");

  const pids = await start("pids");
  exactSystemdPropertiesObserved(pids.values, {
    description: `WorkloadFunnel production gate ${config.runId} pids`,
    ioDevice: config.ioDevice,
    properties,
    slice,
  });
  await waitFor(
    config,
    () => config.pidLimitObserved(plan.diskQuota.root),
    "systemd_pid_limit_not_observed",
    8_000,
  );
  await stop(pids.unit);

  const io = await start("io");
  exactSystemdPropertiesObserved(io.values, {
    description: `WorkloadFunnel production gate ${config.runId} io`,
    ioDevice: config.ioDevice,
    properties,
    slice,
  });
  const ioTerminal = await waitFor(
    config,
    async () => {
      const values = await show(io.unit);
      return values?.ActiveState === "failed" ||
        values?.ActiveState === "inactive"
        ? values
        : undefined;
    },
    "systemd_runtime_limit_timeout",
    10_000,
  );
  if (ioTerminal.Result !== "timeout")
    throw new Error("systemd_runtime_limit_unclassified");
  const ioBytes = await config.ioBytesWritten(plan.diskQuota.root);
  if (ioBytes <= 0 || ioBytes > 8 * 1024 * 1024)
    throw new Error("systemd_io_limit_not_bounded");

  const cpu = await start("cpu");
  exactSystemdPropertiesObserved(cpu.values, {
    description: `WorkloadFunnel production gate ${config.runId} cpu`,
    ioDevice: config.ioDevice,
    properties,
    slice,
  });
  const cpuTerminal = await waitFor(
    config,
    async () => {
      const values = await show(cpu.unit);
      return values?.ActiveState === "failed" ||
        values?.ActiveState === "inactive"
        ? values
        : undefined;
    },
    "systemd_cpu_runtime_limit_timeout",
    10_000,
  );
  if (cpuTerminal.Result !== "timeout")
    throw new Error("systemd_cpu_limit_unclassified");

  return Object.freeze({
    cgroupV2Controllers: config.capabilityEvidence.cgroupV2Controllers,
    controlGroup: tree.values.ControlGroup,
    cancelLatencyMs,
    cpuLimitClassification: cpuTerminal.Result,
    descendantCount: descendantPids.length,
    invocationId: tree.values.InvocationID,
    ioBytes,
    ioLimitClassified: true,
    memoryLimitClassification: "memory_limit_oom",
    pidLimitClassification: "pids_limit_enforced",
    processTreeCancellation: true,
    projectQuotaApplied: false,
    resourceMappingDigest: plan.profileDigest,
    runtimeLimitClassification: ioTerminal.Result,
    systemdVersion: config.capabilityReport.systemdVersion,
  });
}
