export const HOST_SURVIVAL_PROFILE_SCHEMA =
  "phase4c.host-survival-profile.v1" as const;

export interface ProtectedSliceControls {
  readonly cpuWeight: number;
  readonly ioWeight: number;
  readonly managedOomMemoryPressure: "avoid";
  readonly memoryLowBytes: bigint;
  readonly memoryMinBytes: bigint;
  readonly oomPolicy: "continue";
  readonly oomScoreAdjust: number;
  readonly restartBurst: number;
  readonly restartIntervalMicroseconds: bigint;
  readonly tasksMaximum: number;
}

export interface WorkloadSliceControls {
  readonly cpuWeight: number;
  readonly ioWeight: number;
  readonly managedOomMemoryPressure: "kill" | "none";
  readonly memoryHighBytes: bigint;
  readonly memoryMaximumBytes: bigint;
  readonly oomPolicy: "stop";
  readonly tasksMaximum: number;
}

export type StorageHeadroomClass =
  | "artifact_staging"
  | "launcher_wal"
  | "logs"
  | "node_spool"
  | "postgres_data"
  | "postgres_wal"
  | "scheduler_journal";

export interface StorageHeadroom {
  readonly class: StorageHeadroomClass;
  readonly minimumFreeBytes: bigint;
  readonly minimumFreeInodes: bigint;
}

export interface StorageHeadroomObservation {
  readonly class: StorageHeadroomClass;
  readonly freeBytes: bigint;
  readonly freeInodes: bigint;
}

export type StorageHeadroomDecision = Readonly<
  | { readonly status: "satisfied" }
  | {
      readonly exhaustedClasses: readonly StorageHeadroomClass[];
      readonly status: "critical";
    }
>;

export interface HostSurvivalProfile {
  readonly controlSlice: ProtectedSliceControls;
  readonly pressurePolicyBinding: Readonly<{
    readonly digest: string;
    readonly policyId: string;
    readonly revision: number;
  }>;
  readonly profileId: string;
  readonly revision: number;
  readonly schemaVersion: typeof HOST_SURVIVAL_PROFILE_SCHEMA;
  readonly storageHeadroom: readonly StorageHeadroom[];
  readonly systemdOomdEnabled: boolean;
  readonly workloadSlice: WorkloadSliceControls;
}

function boundedWeight(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

export function validateHostSurvivalProfile(
  profile: HostSurvivalProfile,
): void {
  const schemaVersion: unknown = profile.schemaVersion;
  if (schemaVersion !== HOST_SURVIVAL_PROFILE_SCHEMA) {
    throw new Error("unsupported_host_survival_profile_schema");
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(profile.profileId)) {
    throw new Error("invalid_host_survival_profile_id");
  }
  if (!Number.isSafeInteger(profile.revision) || profile.revision < 1) {
    throw new Error("invalid_host_survival_revision");
  }
  if (
    !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(
      profile.pressurePolicyBinding.policyId,
    ) ||
    !Number.isSafeInteger(profile.pressurePolicyBinding.revision) ||
    profile.pressurePolicyBinding.revision < 1 ||
    !/^[a-f0-9]{64}$/u.test(profile.pressurePolicyBinding.digest)
  ) {
    throw new Error("invalid_pressure_policy_binding");
  }
  const control = profile.controlSlice;
  const workload = profile.workloadSlice;
  if (
    !boundedWeight(control.cpuWeight) ||
    !boundedWeight(control.ioWeight) ||
    !boundedWeight(workload.cpuWeight) ||
    !boundedWeight(workload.ioWeight) ||
    control.cpuWeight <= workload.cpuWeight ||
    control.ioWeight <= workload.ioWeight
  ) {
    throw new Error("invalid_host_survival_weights");
  }
  if (
    control.memoryMinBytes <= 0n ||
    control.memoryLowBytes < control.memoryMinBytes ||
    workload.memoryHighBytes <= 0n ||
    workload.memoryMaximumBytes < workload.memoryHighBytes
  ) {
    throw new Error("invalid_host_survival_memory");
  }
  if (
    !Number.isSafeInteger(control.tasksMaximum) ||
    control.tasksMaximum < 1 ||
    !Number.isSafeInteger(workload.tasksMaximum) ||
    workload.tasksMaximum < 1 ||
    !Number.isSafeInteger(control.restartBurst) ||
    control.restartBurst < 1 ||
    control.restartIntervalMicroseconds <= 0n ||
    control.oomScoreAdjust < -1_000 ||
    control.oomScoreAdjust > 1_000
  ) {
    throw new Error("invalid_host_survival_process_controls");
  }
  const controlManagedOom: unknown = control.managedOomMemoryPressure;
  if (controlManagedOom !== "avoid" || control.oomScoreAdjust >= 0) {
    throw new Error("control_slice_must_be_oom_protected");
  }
  if (
    profile.systemdOomdEnabled &&
    workload.managedOomMemoryPressure !== "kill"
  ) {
    throw new Error("workload_slice_must_be_oomd_candidate");
  }
  const classes = new Set<StorageHeadroomClass>();
  for (const headroom of profile.storageHeadroom) {
    if (classes.has(headroom.class))
      throw new Error("duplicate_storage_headroom");
    classes.add(headroom.class);
    if (headroom.minimumFreeBytes <= 0n || headroom.minimumFreeInodes <= 0n) {
      throw new Error("invalid_storage_headroom");
    }
  }
  const required: readonly StorageHeadroomClass[] = [
    "artifact_staging",
    "launcher_wal",
    "logs",
    "node_spool",
    "postgres_data",
    "postgres_wal",
    "scheduler_journal",
  ];
  if (required.some((name) => !classes.has(name))) {
    throw new Error("incomplete_storage_headroom");
  }
}

export function evaluateStorageHeadroom(
  profile: HostSurvivalProfile,
  observations: readonly StorageHeadroomObservation[],
): StorageHeadroomDecision {
  validateHostSurvivalProfile(profile);
  const observed = new Map<StorageHeadroomClass, StorageHeadroomObservation>();
  for (const observation of observations) {
    if (observed.has(observation.class)) {
      throw new Error("duplicate_storage_headroom_observation");
    }
    if (observation.freeBytes < 0n || observation.freeInodes < 0n) {
      throw new Error("invalid_storage_headroom_observation");
    }
    observed.set(observation.class, observation);
  }
  const exhausted = profile.storageHeadroom
    .filter((required) => {
      const actual = observed.get(required.class);
      return (
        actual === undefined ||
        actual.freeBytes <= required.minimumFreeBytes ||
        actual.freeInodes <= required.minimumFreeInodes
      );
    })
    .map((required) => required.class)
    .sort();
  return exhausted.length === 0
    ? Object.freeze({ status: "satisfied" })
    : Object.freeze({
        exhaustedClasses: Object.freeze(exhausted),
        status: "critical",
      });
}
