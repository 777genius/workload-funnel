export const RESOURCE_CONTROL_SCHEMA = "phase4c.resource-controls.v1" as const;

export type ResourceEnforcementCapability =
  | "cgroup_v2"
  | "control_slice_protection"
  | "cpu_quota"
  | "cpu_weight"
  | "dedicated_identity"
  | "device_policy"
  | "ephemeral_disk_inode_quota"
  | "ephemeral_disk_quota"
  | "file_descriptor_limit"
  | "io_device_bandwidth"
  | "io_weight"
  | "linux_capability_drop"
  | "memory_high"
  | "memory_max"
  | "memory_swap_max"
  | "memory_swap_infinity_authorized"
  | "network_isolation"
  | "no_new_privileges"
  | "pinned_execution_paths"
  | "private_devices"
  | "private_tmp"
  | "process_tree_kill"
  | "protected_kernel_state"
  | "read_only_root"
  | "runtime_limit"
  | "seccomp_policy"
  | "secret_delivery_isolation"
  | "storage_headroom_enforcement"
  | "systemd_managed_oom"
  | "systemd_transient_service"
  | "tasks_max";

export interface ResourceEnforcementCapabilityReport {
  readonly capabilities: Readonly<
    Record<ResourceEnforcementCapability, boolean>
  >;
  readonly productionStart: false;
}

export interface CpuResourceGrant {
  readonly quotaPerSecondMicroseconds?: bigint;
  readonly weight: number;
}

export type MemorySwapGrant = Readonly<
  | { readonly maximumBytes: bigint; readonly mode: "limited" }
  | {
      readonly authorization: "explicit";
      readonly mode: "infinity";
      readonly requiredCapability: "memory_swap_infinity_authorized";
    }
>;

export interface MemoryResourceGrant {
  readonly highBytes: bigint;
  readonly maximumBytes: bigint;
  readonly swap: MemorySwapGrant;
}

export interface IoDeviceLimit {
  readonly device: string;
  readonly readBytesPerSecond?: bigint;
  readonly writeBytesPerSecond?: bigint;
}

export interface IoResourceGrant {
  readonly devices: readonly IoDeviceLimit[];
  readonly weight: number;
}

export interface EphemeralStorageGrant {
  readonly allocationId: string;
  readonly inodeMaximum: bigint;
  readonly maximumBytes: bigint;
  readonly root: string;
}

export interface ResourceControlGrant {
  readonly cpu: CpuResourceGrant;
  readonly ephemeralStorage: EphemeralStorageGrant;
  readonly fileDescriptorMaximum: number;
  readonly io: IoResourceGrant;
  readonly memory: MemoryResourceGrant;
  readonly processLimit: number;
  readonly runtimeMaximumMicroseconds: bigint;
  readonly schemaVersion: typeof RESOURCE_CONTROL_SCHEMA;
}

export class InvalidResourceControlProfileError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = "InvalidResourceControlProfileError";
  }
}

function positiveBigInt(value: bigint, code: string): void {
  if (value <= 0n) throw new InvalidResourceControlProfileError(code);
}

function positiveSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidResourceControlProfileError(code);
  }
}

export function validateResourceControlGrant(
  grant: ResourceControlGrant,
): void {
  const schemaVersion: unknown = grant.schemaVersion;
  if (schemaVersion !== RESOURCE_CONTROL_SCHEMA) {
    throw new InvalidResourceControlProfileError("unsupported_resource_schema");
  }
  positiveSafeInteger(grant.cpu.weight, "invalid_cpu_weight");
  if (grant.cpu.weight > 10_000) {
    throw new InvalidResourceControlProfileError("invalid_cpu_weight");
  }
  if (grant.cpu.quotaPerSecondMicroseconds !== undefined) {
    positiveBigInt(grant.cpu.quotaPerSecondMicroseconds, "invalid_cpu_quota");
  }
  positiveBigInt(grant.memory.highBytes, "invalid_memory_high");
  positiveBigInt(grant.memory.maximumBytes, "invalid_memory_maximum");
  if (grant.memory.highBytes > grant.memory.maximumBytes) {
    throw new InvalidResourceControlProfileError("memory_high_exceeds_maximum");
  }
  const swap: unknown = grant.memory.swap;
  if (typeof swap !== "object" || swap === null || !("mode" in swap)) {
    throw new InvalidResourceControlProfileError(
      "explicit_memory_swap_policy_required",
    );
  }
  const typedSwap = swap as {
    readonly authorization?: unknown;
    readonly maximumBytes?: unknown;
    readonly mode?: unknown;
    readonly requiredCapability?: unknown;
  };
  if (typedSwap.mode === "limited") {
    if (
      typeof typedSwap.maximumBytes !== "bigint" ||
      typedSwap.maximumBytes < 0n
    ) {
      throw new InvalidResourceControlProfileError(
        "invalid_memory_swap_maximum",
      );
    }
  } else if (
    typedSwap.mode !== "infinity" ||
    typedSwap.authorization !== "explicit" ||
    typedSwap.requiredCapability !== "memory_swap_infinity_authorized"
  ) {
    throw new InvalidResourceControlProfileError(
      "invalid_memory_swap_authorization",
    );
  }
  positiveSafeInteger(grant.processLimit, "invalid_process_limit");
  positiveSafeInteger(grant.io.weight, "invalid_io_weight");
  if (grant.io.weight > 10_000) {
    throw new InvalidResourceControlProfileError("invalid_io_weight");
  }
  const devices = new Set<string>();
  for (const device of grant.io.devices) {
    if (!/^\/dev\/[A-Za-z0-9._-]+$/u.test(device.device)) {
      throw new InvalidResourceControlProfileError("invalid_io_device");
    }
    if (devices.has(device.device)) {
      throw new InvalidResourceControlProfileError("duplicate_io_device");
    }
    devices.add(device.device);
    if (
      device.readBytesPerSecond === undefined &&
      device.writeBytesPerSecond === undefined
    ) {
      throw new InvalidResourceControlProfileError("empty_io_device_limit");
    }
    if (device.readBytesPerSecond !== undefined) {
      positiveBigInt(device.readBytesPerSecond, "invalid_io_read_limit");
    }
    if (device.writeBytesPerSecond !== undefined) {
      positiveBigInt(device.writeBytesPerSecond, "invalid_io_write_limit");
    }
  }
  positiveBigInt(
    grant.ephemeralStorage.maximumBytes,
    "invalid_ephemeral_storage_maximum",
  );
  positiveBigInt(
    grant.ephemeralStorage.inodeMaximum,
    "invalid_ephemeral_inode_maximum",
  );
  if (!/^[a-z0-9-]+$/u.test(grant.ephemeralStorage.allocationId)) {
    throw new InvalidResourceControlProfileError("invalid_quota_allocation_id");
  }
  if (
    grant.ephemeralStorage.root !==
    `/var/lib/workload-funnel/allocations/${grant.ephemeralStorage.allocationId}`
  ) {
    throw new InvalidResourceControlProfileError(
      "invalid_ephemeral_storage_root",
    );
  }
  positiveSafeInteger(
    grant.fileDescriptorMaximum,
    "invalid_file_descriptor_maximum",
  );
  positiveBigInt(grant.runtimeMaximumMicroseconds, "invalid_runtime_maximum");
}
