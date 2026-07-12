import {
  HOST_SURVIVAL_PROFILE_SCHEMA,
  RESOURCE_CONTROL_SCHEMA,
  SANDBOX_PROFILE_SCHEMA,
  type HostSurvivalProfile,
  type ResourceEnforcementCapability,
  type SandboxProfile,
  fingerprintSandboxProfile,
  validateHostSurvivalProfile,
} from "@workload-funnel/node-execution/resource-enforcement";

export const SYNTHETIC_SANDBOX_PROFILE_ID =
  "synthetic-process-tree-v1" as const;

const syntheticCapabilities = Object.freeze([
  "cgroup_v2",
  "cpu_quota",
  "cpu_weight",
  "dedicated_identity",
  "device_policy",
  "ephemeral_disk_inode_quota",
  "ephemeral_disk_quota",
  "file_descriptor_limit",
  "io_device_bandwidth",
  "io_weight",
  "linux_capability_drop",
  "memory_high",
  "memory_max",
  "memory_swap_max",
  "network_isolation",
  "no_new_privileges",
  "private_devices",
  "private_tmp",
  "process_tree_kill",
  "protected_kernel_state",
  "read_only_root",
  "runtime_limit",
  "seccomp_policy",
  "systemd_transient_service",
  "tasks_max",
] satisfies readonly ResourceEnforcementCapability[]);

export function createSyntheticSandboxProfile(
  allocationId: string,
): SandboxProfile {
  if (!/^[a-z0-9-]+$/u.test(allocationId)) {
    throw new Error("synthetic_allocation_id_not_path_safe");
  }
  const allocationRoot = `/var/lib/workload-funnel/allocations/${allocationId}`;
  return Object.freeze({
    group: "workload-funnel-synthetic",
    hostControl: "denied",
    isolation: Object.freeze({
      capabilityBoundingSet: Object.freeze([]),
      devicePolicy: "closed",
      network: "none",
      noNewPrivileges: true,
      privateDevices: true,
      privateTmp: true,
      protectControlGroups: true,
      protectKernelModules: true,
      protectKernelTunables: true,
      protectSystem: "strict",
      requiresPinnedExecutionPaths: false,
      syscallPolicy: "trusted_baseline",
      writableRoots: Object.freeze([
        allocationRoot,
        `${allocationRoot}/output`,
      ]),
    }),
    productionEligible: false,
    profileId: SYNTHETIC_SANDBOX_PROFILE_ID,
    requiredCapabilities: syntheticCapabilities,
    resources: Object.freeze({
      cpu: Object.freeze({
        quotaPerSecondMicroseconds: 500_000n,
        weight: 100,
      }),
      ephemeralStorage: Object.freeze({
        allocationId,
        inodeMaximum: 4_096n,
        maximumBytes: 67_108_864n,
        root: allocationRoot,
      }),
      fileDescriptorMaximum: 1_024,
      io: Object.freeze({
        devices: Object.freeze([
          Object.freeze({
            device: "/dev/workload-funnel-test",
            readBytesPerSecond: 16_777_216n,
            writeBytesPerSecond: 8_388_608n,
          }),
        ]),
        weight: 100,
      }),
      memory: Object.freeze({
        highBytes: 134_217_728n,
        maximumBytes: 201_326_592n,
        swap: Object.freeze({ maximumBytes: 0n, mode: "limited" }),
      }),
      processLimit: 64,
      runtimeMaximumMicroseconds: 300_000_000n,
      schemaVersion: RESOURCE_CONTROL_SCHEMA,
    }),
    schemaVersion: SANDBOX_PROFILE_SCHEMA,
    testSurfaceOnly: true,
    trustedProcessOnly: true,
    user: "workload-funnel-synthetic",
  });
}

export function fingerprintSyntheticSandboxProfile(
  allocationId: string,
): string {
  return fingerprintSandboxProfile(createSyntheticSandboxProfile(allocationId));
}

export function createSyntheticHostSurvivalProfile(): HostSurvivalProfile {
  const storageHeadroom = [
    "artifact_staging",
    "launcher_wal",
    "logs",
    "node_spool",
    "postgres_data",
    "postgres_wal",
    "scheduler_journal",
  ].map((name) =>
    Object.freeze({
      class: name,
      minimumFreeBytes: 67_108_864n,
      minimumFreeInodes: 1_024n,
    }),
  ) as HostSurvivalProfile["storageHeadroom"];
  const profile: HostSurvivalProfile = Object.freeze({
    controlSlice: Object.freeze({
      cpuWeight: 10_000,
      ioWeight: 10_000,
      managedOomMemoryPressure: "avoid",
      memoryLowBytes: 268_435_456n,
      memoryMinBytes: 134_217_728n,
      oomPolicy: "continue",
      oomScoreAdjust: -900,
      restartBurst: 3,
      restartIntervalMicroseconds: 60_000_000n,
      tasksMaximum: 256,
    }),
    profileId: "single-host-survival-v1",
    pressurePolicyBinding: Object.freeze({
      digest:
        "214be3951451489c9b7a9a685a9c25384f1a3abe630ca7c285614042379a1c3e",
      policyId: "single-host-pressure-v1",
      revision: 1,
    }),
    revision: 1,
    schemaVersion: HOST_SURVIVAL_PROFILE_SCHEMA,
    storageHeadroom: Object.freeze(storageHeadroom),
    systemdOomdEnabled: true,
    workloadSlice: Object.freeze({
      cpuWeight: 100,
      ioWeight: 100,
      managedOomMemoryPressure: "kill",
      memoryHighBytes: 1_073_741_824n,
      memoryMaximumBytes: 1_610_612_736n,
      oomPolicy: "stop",
      tasksMaximum: 1_024,
    }),
  });
  validateHostSurvivalProfile(profile);
  return profile;
}
