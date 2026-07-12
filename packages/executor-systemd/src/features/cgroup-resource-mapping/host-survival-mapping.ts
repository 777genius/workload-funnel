import {
  validateHostSurvivalProfile,
  type HostSurvivalProfile,
  type ResourceEnforcementCapability,
  type ResourceEnforcementCapabilityReport,
  type StorageHeadroom,
} from "@workload-funnel/node-execution/resource-enforcement";

export interface ControlSliceSystemdProperties {
  readonly CPUWeight: number;
  readonly IOWeight: number;
  readonly ManagedOOMMemoryPressure: "avoid";
  readonly MemoryLow: bigint;
  readonly MemoryMin: bigint;
  readonly OOMPolicy: "continue";
  readonly OOMScoreAdjust: number;
  readonly StartLimitBurst: number;
  readonly StartLimitIntervalUSec: bigint;
  readonly TasksMax: number;
}

export interface WorkloadSliceSystemdProperties {
  readonly CPUWeight: number;
  readonly IOWeight: number;
  readonly ManagedOOMMemoryPressure: "kill" | "none";
  readonly MemoryHigh: bigint;
  readonly MemoryMax: bigint;
  readonly OOMPolicy: "stop";
  readonly TasksMax: number;
}

export interface HostSurvivalControlPlan {
  readonly controlSlice: ControlSliceSystemdProperties;
  readonly profileId: string;
  readonly revision: number;
  readonly storageHeadroom: readonly StorageHeadroom[];
  readonly systemdOomdEnabled: boolean;
  readonly workloadSlice: WorkloadSliceSystemdProperties;
}

export type HostSurvivalControlDecision =
  | (HostSurvivalControlPlan & { readonly status: "supported" })
  | Readonly<{
      missingCapabilities: readonly ResourceEnforcementCapability[];
      status: "unsupported";
    }>;

export function mapHostSurvivalControls(
  profile: HostSurvivalProfile,
  report: ResourceEnforcementCapabilityReport,
): HostSurvivalControlDecision {
  validateHostSurvivalProfile(profile);
  const required = Object.freeze([
    "control_slice_protection",
    "storage_headroom_enforcement",
    "systemd_managed_oom",
  ] satisfies readonly ResourceEnforcementCapability[]);
  const missing = required.filter(
    (capability) => !report.capabilities[capability],
  );
  if (missing.length > 0) {
    return Object.freeze({
      missingCapabilities: Object.freeze(missing),
      status: "unsupported",
    });
  }
  return Object.freeze({
    controlSlice: Object.freeze({
      CPUWeight: profile.controlSlice.cpuWeight,
      IOWeight: profile.controlSlice.ioWeight,
      ManagedOOMMemoryPressure: "avoid",
      MemoryLow: profile.controlSlice.memoryLowBytes,
      MemoryMin: profile.controlSlice.memoryMinBytes,
      OOMPolicy: "continue",
      OOMScoreAdjust: profile.controlSlice.oomScoreAdjust,
      StartLimitBurst: profile.controlSlice.restartBurst,
      StartLimitIntervalUSec: profile.controlSlice.restartIntervalMicroseconds,
      TasksMax: profile.controlSlice.tasksMaximum,
    }),
    profileId: profile.profileId,
    revision: profile.revision,
    storageHeadroom: Object.freeze([...profile.storageHeadroom]),
    status: "supported",
    systemdOomdEnabled: profile.systemdOomdEnabled,
    workloadSlice: Object.freeze({
      CPUWeight: profile.workloadSlice.cpuWeight,
      IOWeight: profile.workloadSlice.ioWeight,
      ManagedOOMMemoryPressure: profile.workloadSlice.managedOomMemoryPressure,
      MemoryHigh: profile.workloadSlice.memoryHighBytes,
      MemoryMax: profile.workloadSlice.memoryMaximumBytes,
      OOMPolicy: profile.workloadSlice.oomPolicy,
      TasksMax: profile.workloadSlice.tasksMaximum,
    }),
  });
}
