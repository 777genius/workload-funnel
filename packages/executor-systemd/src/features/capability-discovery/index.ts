import type {
  ResourceEnforcementCapability,
  ResourceEnforcementCapabilityReport,
} from "@workload-funnel/node-execution/resource-enforcement";

export const SYSTEMD_CAPABILITY_REPORT_SCHEMA =
  "phase4c.systemd-capabilities.v1" as const;

export interface SystemdCapabilityProbe {
  readonly authorizedUnlimitedSwap: boolean;
  readonly cgroupV2Controllers: readonly string[];
  readonly linux: boolean;
  readonly pinnedExecutionPaths: boolean;
  readonly projectQuotaBytes: boolean;
  readonly projectQuotaInodes: boolean;
  readonly storageHeadroomEnforcement: boolean;
  readonly source: "disposable_linux_host" | "synthetic_disposable_linux";
  readonly systemdProperties: readonly string[];
  readonly systemdVersion: number;
  readonly unifiedCgroupV2: boolean;
}

export interface SystemdCapabilityReport extends ResourceEnforcementCapabilityReport {
  readonly capabilities: Readonly<
    Record<ResourceEnforcementCapability, boolean>
  >;
  readonly evidenceSource:
    | "disposable_linux_host"
    | "synthetic_disposable_linux";
  readonly productionStart: false;
  readonly schemaVersion: typeof SYSTEMD_CAPABILITY_REPORT_SCHEMA;
  readonly systemdVersion: number;
}

const requiredProperties = {
  capabilityDrop: ["AmbientCapabilities", "CapabilityBoundingSet"],
  cpuQuota: ["CPUQuotaPerSecUSec"],
  cpuWeight: ["CPUWeight"],
  devicePolicy: ["DevicePolicy"],
  ioDeviceBandwidth: ["IOReadBandwidthMax", "IOWriteBandwidthMax"],
  ioWeight: ["IOWeight"],
  fileDescriptorLimit: ["LimitNOFILE"],
  memoryHigh: ["MemoryHigh"],
  memoryMax: ["MemoryMax"],
  memorySwapMax: ["MemorySwapMax"],
  networkIsolation: ["PrivateNetwork"],
  noNewPrivileges: ["NoNewPrivileges"],
  privateDevices: ["PrivateDevices"],
  privateTmp: ["PrivateTmp"],
  processTreeKill: [
    "FinalKillSignal",
    "KillMode",
    "KillSignal",
    "SendSIGKILL",
    "TimeoutStopUSec",
  ],
  protectedKernelState: [
    "ProtectControlGroups",
    "ProtectKernelModules",
    "ProtectKernelTunables",
  ],
  readOnlyRoot: ["ProtectHome", "ProtectSystem", "ReadWritePaths"],
  runtimeLimit: ["RuntimeMaxUSec"],
  seccomp: ["SystemCallFilter"],
  tasksMax: ["TasksMax"],
} as const;

function hasEvery(
  source: ReadonlySet<string>,
  values: readonly string[],
): boolean {
  return values.every((value) => source.has(value));
}

export function discoverSystemdCapabilities(
  probe: SystemdCapabilityProbe,
): SystemdCapabilityReport {
  if (!Number.isSafeInteger(probe.systemdVersion) || probe.systemdVersion < 0) {
    throw new Error("invalid_systemd_version");
  }
  const properties = new Set(probe.systemdProperties);
  const controllers = new Set(probe.cgroupV2Controllers);
  const systemd = probe.linux && probe.systemdVersion >= 250;
  const cgroup = systemd && probe.unifiedCgroupV2;
  const property = (values: readonly string[]): boolean =>
    systemd && hasEvery(properties, values);
  const capabilities: Record<ResourceEnforcementCapability, boolean> = {
    cgroup_v2: cgroup,
    control_slice_protection: property([
      "CPUWeight",
      "IOWeight",
      "MemoryLow",
      "MemoryMin",
      "OOMScoreAdjust",
      "StartLimitBurst",
      "StartLimitIntervalUSec",
      "TasksMax",
    ]),
    cpu_quota:
      cgroup && controllers.has("cpu") && property(requiredProperties.cpuQuota),
    cpu_weight:
      cgroup &&
      controllers.has("cpu") &&
      property(requiredProperties.cpuWeight),
    dedicated_identity: property(["User", "Group"]),
    device_policy: property(requiredProperties.devicePolicy),
    ephemeral_disk_inode_quota: probe.linux && probe.projectQuotaInodes,
    ephemeral_disk_quota: probe.linux && probe.projectQuotaBytes,
    file_descriptor_limit: property(requiredProperties.fileDescriptorLimit),
    io_device_bandwidth:
      cgroup &&
      controllers.has("io") &&
      property(requiredProperties.ioDeviceBandwidth),
    io_weight:
      cgroup && controllers.has("io") && property(requiredProperties.ioWeight),
    linux_capability_drop: property(requiredProperties.capabilityDrop),
    memory_high:
      cgroup &&
      controllers.has("memory") &&
      property(requiredProperties.memoryHigh),
    memory_max:
      cgroup &&
      controllers.has("memory") &&
      property(requiredProperties.memoryMax),
    memory_swap_max:
      cgroup &&
      controllers.has("memory") &&
      property(requiredProperties.memorySwapMax),
    memory_swap_infinity_authorized:
      probe.authorizedUnlimitedSwap &&
      cgroup &&
      controllers.has("memory") &&
      property(requiredProperties.memorySwapMax),
    network_isolation: property(requiredProperties.networkIsolation),
    no_new_privileges: property(requiredProperties.noNewPrivileges),
    pinned_execution_paths: systemd && probe.pinnedExecutionPaths,
    private_devices: property(requiredProperties.privateDevices),
    private_tmp: property(requiredProperties.privateTmp),
    process_tree_kill: property(requiredProperties.processTreeKill),
    protected_kernel_state: property(requiredProperties.protectedKernelState),
    read_only_root: property(requiredProperties.readOnlyRoot),
    runtime_limit: property(requiredProperties.runtimeLimit),
    seccomp_policy: property(requiredProperties.seccomp),
    secret_delivery_isolation: false,
    storage_headroom_enforcement:
      probe.linux && probe.storageHeadroomEnforcement,
    systemd_managed_oom: property(["ManagedOOMMemoryPressure", "OOMPolicy"]),
    systemd_transient_service: systemd,
    tasks_max:
      cgroup &&
      controllers.has("pids") &&
      property(requiredProperties.tasksMax),
  };
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    evidenceSource: probe.source,
    productionStart: false,
    schemaVersion: SYSTEMD_CAPABILITY_REPORT_SCHEMA,
    systemdVersion: probe.systemdVersion,
  });
}

export function syntheticDisposableLinuxProbe(): SystemdCapabilityProbe {
  return Object.freeze({
    authorizedUnlimitedSwap: false,
    cgroupV2Controllers: Object.freeze(["cpu", "io", "memory", "pids"]),
    linux: true,
    pinnedExecutionPaths: false,
    projectQuotaBytes: true,
    projectQuotaInodes: true,
    storageHeadroomEnforcement: true,
    source: "synthetic_disposable_linux",
    systemdProperties: Object.freeze([
      "AmbientCapabilities",
      "CapabilityBoundingSet",
      "CPUQuotaPerSecUSec",
      "CPUWeight",
      "DevicePolicy",
      "FinalKillSignal",
      "Group",
      "IOReadBandwidthMax",
      "IOWeight",
      "IOWriteBandwidthMax",
      "KillMode",
      "KillSignal",
      "LimitNOFILE",
      "MemoryHigh",
      "MemoryLow",
      "MemoryMax",
      "MemoryMin",
      "MemorySwapMax",
      "ManagedOOMMemoryPressure",
      "NoNewPrivileges",
      "OOMPolicy",
      "OOMScoreAdjust",
      "PrivateDevices",
      "PrivateNetwork",
      "PrivateTmp",
      "ProtectHome",
      "ProtectControlGroups",
      "ProtectKernelModules",
      "ProtectKernelTunables",
      "ProtectSystem",
      "ReadWritePaths",
      "RuntimeMaxUSec",
      "SendSIGKILL",
      "StartLimitBurst",
      "StartLimitIntervalUSec",
      "SystemCallFilter",
      "TasksMax",
      "TimeoutStopUSec",
      "User",
    ]),
    systemdVersion: 255,
    unifiedCgroupV2: true,
  });
}
