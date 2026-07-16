import { createHash } from "node:crypto";

import {
  fingerprintSandboxProfile,
  requiredSandboxCapabilities,
  validateSandboxProfile,
  type ResourceEnforcementCapability,
  type ResourceEnforcementCapabilityReport,
  type SandboxProfile,
} from "@workload-funnel/node-execution/resource-enforcement";

export interface SystemdExecutionProperties {
  readonly AmbientCapabilities: readonly [];
  readonly CapabilityBoundingSet: readonly [];
  readonly CPUQuotaPerSecUSec?: bigint;
  readonly CPUWeight: number;
  readonly DevicePolicy: "closed";
  readonly Group: string;
  readonly IOReadBandwidthMax: readonly (readonly [string, bigint])[];
  readonly IOWeight: number;
  readonly IOWriteBandwidthMax: readonly (readonly [string, bigint])[];
  readonly KillMode: "control-group";
  readonly LimitNOFILE: number;
  readonly MemoryHigh: bigint;
  readonly MemoryMax: bigint;
  readonly MemorySwapMax: bigint | "infinity";
  readonly NoNewPrivileges: true;
  readonly PrivateDevices: true;
  readonly PrivateNetwork: boolean;
  readonly PrivateTmp: true;
  readonly ProtectControlGroups: true;
  readonly ProtectKernelModules: true;
  readonly ProtectKernelTunables: true;
  readonly ProtectSystem: "strict";
  readonly ReadWritePaths: readonly string[];
  readonly RuntimeMaxUSec: bigint;
  readonly SystemCallFilter: readonly string[];
  readonly TasksMax: number;
  readonly User: string;
}

export interface ProjectQuotaControl {
  readonly allocationId: string;
  readonly inodeMaximum: bigint;
  readonly maximumBytes: bigint;
  readonly projectId: number;
  readonly root: string;
}

export function deterministicProjectQuotaId(allocationId: string): number {
  if (!/^[a-z0-9-]+$/u.test(allocationId)) {
    throw new Error("invalid_quota_allocation_id");
  }
  const digest = createHash("sha256").update(allocationId, "utf8").digest();
  const minimumProjectId = 100_000;
  const projectIdRange = 2_147_483_647 - minimumProjectId;
  return minimumProjectId + (digest.readUInt32BE(0) % projectIdRange);
}

export interface SystemdExecutionControlPlan {
  readonly diskQuota: ProjectQuotaControl;
  readonly profileDigest: string;
  readonly properties: SystemdExecutionProperties;
  readonly status: "supported";
  readonly swapPolicy: Readonly<
    | { readonly mode: "limited" }
    | {
        readonly authorizationCapability: "memory_swap_infinity_authorized";
        readonly mode: "infinity";
      }
  >;
}

export type SystemdExecutionControlDecision =
  | SystemdExecutionControlPlan
  | Readonly<{
      missingCapabilities: readonly ResourceEnforcementCapability[];
      reason: "production_start_disabled" | "unsupported_profile_capability";
      status: "unsupported";
    }>;

export type ExecutionSurface =
  | "production"
  | "synthetic_disposable_linux_fixture";

export function mapSystemdExecutionControls(
  profile: SandboxProfile,
  report: ResourceEnforcementCapabilityReport,
  surface: ExecutionSurface,
): SystemdExecutionControlDecision {
  validateSandboxProfile(profile);
  if (
    surface === "production" ||
    !profile.testSurfaceOnly ||
    profile.productionEligible
  ) {
    return Object.freeze({
      missingCapabilities: Object.freeze([]),
      reason: "production_start_disabled",
      status: "unsupported",
    });
  }
  const required = new Set([
    ...profile.requiredCapabilities,
    ...requiredSandboxCapabilities(profile),
  ]);
  const missing = [...required]
    .filter((capability) => !report.capabilities[capability])
    .sort();
  if (missing.length > 0) {
    return Object.freeze({
      missingCapabilities: Object.freeze(missing),
      reason: "unsupported_profile_capability",
      status: "unsupported",
    });
  }
  const resources = profile.resources;
  const readLimits = resources.io.devices.flatMap((device) =>
    device.readBytesPerSecond === undefined
      ? []
      : [[device.device, device.readBytesPerSecond] as const],
  );
  const writeLimits = resources.io.devices.flatMap((device) =>
    device.writeBytesPerSecond === undefined
      ? []
      : [[device.device, device.writeBytesPerSecond] as const],
  );
  const properties: SystemdExecutionProperties = Object.freeze({
    AmbientCapabilities: Object.freeze([] as const),
    CapabilityBoundingSet: Object.freeze([] as const),
    ...(resources.cpu.quotaPerSecondMicroseconds === undefined
      ? {}
      : { CPUQuotaPerSecUSec: resources.cpu.quotaPerSecondMicroseconds }),
    CPUWeight: resources.cpu.weight,
    DevicePolicy: profile.isolation.devicePolicy,
    Group: profile.group,
    IOReadBandwidthMax: Object.freeze(readLimits),
    IOWeight: resources.io.weight,
    IOWriteBandwidthMax: Object.freeze(writeLimits),
    KillMode: "control-group",
    LimitNOFILE: resources.fileDescriptorMaximum,
    MemoryHigh: resources.memory.highBytes,
    MemoryMax: resources.memory.maximumBytes,
    MemorySwapMax:
      resources.memory.swap.mode === "limited"
        ? resources.memory.swap.maximumBytes
        : "infinity",
    NoNewPrivileges: profile.isolation.noNewPrivileges,
    PrivateDevices: profile.isolation.privateDevices,
    PrivateNetwork: profile.isolation.network === "none",
    PrivateTmp: profile.isolation.privateTmp,
    ProtectControlGroups: profile.isolation.protectControlGroups,
    ProtectKernelModules: profile.isolation.protectKernelModules,
    ProtectKernelTunables: profile.isolation.protectKernelTunables,
    ProtectSystem: profile.isolation.protectSystem,
    ReadWritePaths: Object.freeze([...profile.isolation.writableRoots]),
    RuntimeMaxUSec: resources.runtimeMaximumMicroseconds,
    SystemCallFilter: Object.freeze([
      "@system-service",
      "~@mount @privileged @resources",
    ]),
    TasksMax: resources.processLimit,
    User: profile.user,
  });
  return Object.freeze({
    diskQuota: Object.freeze({
      allocationId: resources.ephemeralStorage.allocationId,
      inodeMaximum: resources.ephemeralStorage.inodeMaximum,
      maximumBytes: resources.ephemeralStorage.maximumBytes,
      projectId: deterministicProjectQuotaId(
        resources.ephemeralStorage.allocationId,
      ),
      root: resources.ephemeralStorage.root,
    }),
    profileDigest: fingerprintSandboxProfile(profile),
    properties,
    status: "supported",
    swapPolicy: Object.freeze(
      resources.memory.swap.mode === "limited"
        ? { mode: "limited" as const }
        : {
            authorizationCapability: "memory_swap_infinity_authorized" as const,
            mode: "infinity" as const,
          },
    ),
  });
}
