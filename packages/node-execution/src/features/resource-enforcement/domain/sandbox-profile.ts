import {
  type ResourceControlGrant,
  type ResourceEnforcementCapability,
  validateResourceControlGrant,
} from "./resource-controls.js";

export const SANDBOX_PROFILE_SCHEMA = "phase4c.sandbox-profile.v1" as const;

export interface SandboxIsolationPolicy {
  readonly capabilityBoundingSet: readonly string[];
  readonly devicePolicy: "closed";
  readonly network: "none" | "host";
  readonly noNewPrivileges: true;
  readonly privateDevices: true;
  readonly privateTmp: true;
  readonly protectControlGroups: true;
  readonly protectKernelModules: true;
  readonly protectKernelTunables: true;
  readonly protectSystem: "strict";
  readonly requiresPinnedExecutionPaths: boolean;
  readonly syscallPolicy: "trusted_baseline";
  readonly writableRoots: readonly string[];
}

export interface SandboxProfile {
  readonly group: string;
  readonly hostControl:
    | "denied"
    | "dedicated_node"
    | "rootless_per_allocation"
    | "typed_broker";
  readonly isolation: SandboxIsolationPolicy;
  readonly productionEligible: boolean;
  readonly profileId: string;
  readonly requiredCapabilities: readonly ResourceEnforcementCapability[];
  readonly resources: ResourceControlGrant;
  readonly schemaVersion: typeof SANDBOX_PROFILE_SCHEMA;
  readonly testSurfaceOnly: boolean;
  readonly trustedProcessOnly: true;
  readonly user: string;
}

export function requiredSandboxCapabilities(
  profile: SandboxProfile,
): readonly ResourceEnforcementCapability[] {
  const capabilities: ResourceEnforcementCapability[] = [
    "cgroup_v2",
    "cpu_weight",
    "dedicated_identity",
    "device_policy",
    "ephemeral_disk_inode_quota",
    "ephemeral_disk_quota",
    "file_descriptor_limit",
    "io_weight",
    "linux_capability_drop",
    "memory_high",
    "memory_max",
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
  ];
  if (profile.resources.cpu.quotaPerSecondMicroseconds !== undefined) {
    capabilities.push("cpu_quota");
  }
  capabilities.push("memory_swap_max");
  if (profile.resources.memory.swap.mode === "infinity") {
    capabilities.push("memory_swap_infinity_authorized");
  }
  if (profile.resources.io.devices.length > 0) {
    capabilities.push("io_device_bandwidth");
  }
  if (profile.isolation.network === "none") {
    capabilities.push("network_isolation");
  }
  if (profile.isolation.requiresPinnedExecutionPaths) {
    capabilities.push("pinned_execution_paths");
  }
  return Object.freeze([...new Set(capabilities)].sort());
}

export function validateSandboxProfile(profile: SandboxProfile): void {
  const schemaVersion: unknown = profile.schemaVersion;
  if (schemaVersion !== SANDBOX_PROFILE_SCHEMA) {
    throw new Error("unsupported_sandbox_profile_schema");
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(profile.profileId)) {
    throw new Error("invalid_sandbox_profile_id");
  }
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(profile.user) ||
    profile.user === "root"
  ) {
    throw new Error("invalid_sandbox_user");
  }
  if (
    !/^[a-z_][a-z0-9_-]{0,31}$/u.test(profile.group) ||
    profile.group === "root"
  ) {
    throw new Error("invalid_sandbox_group");
  }
  if (profile.productionEligible && profile.testSurfaceOnly) {
    throw new Error("test_surface_cannot_be_production_eligible");
  }
  validateResourceControlGrant(profile.resources);
  if (profile.isolation.capabilityBoundingSet.length !== 0) {
    throw new Error("synthetic_profile_capabilities_must_be_empty");
  }
  const writableRoots = new Set<string>();
  for (const root of profile.isolation.writableRoots) {
    if (
      !/^\/var\/lib\/workload-funnel\/allocations\/[a-z0-9-]+(?:\/output)?$/u.test(
        root,
      )
    ) {
      throw new Error("invalid_sandbox_writable_root");
    }
    if (writableRoots.has(root))
      throw new Error("duplicate_sandbox_writable_root");
    writableRoots.add(root);
  }
  const capabilities = new Set(profile.requiredCapabilities);
  if (capabilities.size !== profile.requiredCapabilities.length) {
    throw new Error("duplicate_required_capability");
  }
  if (
    requiredSandboxCapabilities(profile).some(
      (capability) => !capabilities.has(capability),
    )
  ) {
    throw new Error("sandbox_profile_omits_required_capability");
  }
  if (
    profile.hostControl !== "denied" &&
    !capabilities.has("network_isolation")
  ) {
    throw new Error("host_control_requires_network_isolation");
  }
}
