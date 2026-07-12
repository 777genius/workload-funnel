import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  isExactProjectQuotaReceipt,
  type TransientProjectQuotaControl,
  type VerifiedProjectQuotaReceipt,
} from "./project-quota-registry.js";

export {
  PROJECT_QUOTA_RECEIPT_SCHEMA,
  ProjectQuotaRegistry,
  fingerprintProjectQuotaControl,
  isExactProjectQuotaReceipt,
  type TransientProjectQuotaControl,
  type VerifiedProjectQuotaReceipt,
} from "./project-quota-registry.js";

export const SYNTHETIC_EXECUTABLE =
  "/usr/libexec/workload-funnel/synthetic-process-tree" as const;
export const SYNTHETIC_SERVICE_USER = "workload-funnel-synthetic" as const;
export const SYNTHETIC_WORKING_DIRECTORY = "/var/empty" as const;

export interface SystemdExecCommand {
  readonly arguments: readonly [typeof SYNTHETIC_EXECUTABLE, "--phase4c-tree"];
  readonly ignoreFailure: false;
  readonly path: typeof SYNTHETIC_EXECUTABLE;
}

export interface TransientUnitProperties {
  readonly AmbientCapabilities: readonly [];
  readonly CapabilityBoundingSet: readonly [];
  readonly CPUQuotaPerSecUSec?: bigint;
  readonly CPUWeight: number;
  readonly DevicePolicy: "closed";
  readonly FinalKillSignal: "SIGKILL";
  readonly Group: string;
  readonly IOReadBandwidthMax: readonly (readonly [string, bigint])[];
  readonly IOWeight: number;
  readonly IOWriteBandwidthMax: readonly (readonly [string, bigint])[];
  readonly KillMode: "control-group";
  readonly KillSignal: "SIGTERM";
  readonly LimitNOFILE: number;
  readonly MemoryHigh: bigint;
  readonly MemoryMax: bigint;
  readonly MemorySwapMax: bigint | "infinity";
  readonly NoNewPrivileges: true;
  readonly PrivateDevices: true;
  readonly PrivateNetwork: boolean;
  readonly PrivateTmp: true;
  readonly ProtectControlGroups: true;
  readonly ProtectHome: true;
  readonly ProtectKernelModules: true;
  readonly ProtectKernelTunables: true;
  readonly ProtectSystem: "strict";
  readonly ReadWritePaths: readonly string[];
  readonly RuntimeMaxUSec: bigint;
  readonly SendSIGKILL: true;
  readonly SystemCallFilter: readonly string[];
  readonly TasksMax: number;
  readonly TimeoutStopUSec: 5_000_000;
  readonly User: string;
  readonly WorkingDirectory: typeof SYNTHETIC_WORKING_DIRECTORY;
}

export interface TransientExecutionControlPlan {
  readonly diskQuota: TransientProjectQuotaControl;
  readonly profileDigest: string;
  readonly properties: Omit<
    TransientUnitProperties,
    | "FinalKillSignal"
    | "KillSignal"
    | "ProtectHome"
    | "SendSIGKILL"
    | "TimeoutStopUSec"
    | "WorkingDirectory"
  >;
  readonly swapPolicy: Readonly<
    | { readonly mode: "limited" }
    | {
        readonly authorizationCapability: "memory_swap_infinity_authorized";
        readonly mode: "infinity";
      }
  >;
}

export interface SyntheticTransientUnit {
  readonly description: "WorkloadFunnel Phase 4C synthetic process tree";
  readonly execStart: readonly [SystemdExecCommand];
  readonly properties: TransientUnitProperties;
  readonly startMode: "fail";
  readonly unitName: string;
}

export interface TransientUnitStartManager {
  readonly projectQuotaControl: "supported" | "unsupported";
  readonly transientServiceStart: "supported" | "unsupported";
  applyProjectQuota(
    control: TransientProjectQuotaControl,
  ): VerifiedProjectQuotaReceipt;
  verifyProjectQuotaReceipt(
    control: TransientProjectQuotaControl,
    receipt: VerifiedProjectQuotaReceipt,
  ): boolean;
  startTransientService(unit: SyntheticTransientUnit): "created" | "exists";
}

export type TransientUnitStartResult =
  | { readonly status: "started"; readonly unitName: string }
  | {
      readonly evidence:
        | "ephemeral_project_quota_unsupported"
        | "systemd_transient_service_start_unsupported";
      readonly status: "unsupported";
    };

function assertUnitName(unitName: string): void {
  if (!/^workload-funnel-phase4a-[a-f0-9]{32}\.service$/u.test(unitName)) {
    throw new Error("deterministic unit name is invalid");
  }
}

function validateControlPlan(plan: TransientExecutionControlPlan): void {
  if (!/^[a-f0-9]{64}$/u.test(plan.profileDigest)) {
    throw new Error("invalid_sandbox_profile_digest");
  }
  const properties = plan.properties as unknown as Readonly<
    Record<string, unknown>
  >;
  const swapPolicy = plan.swapPolicy as unknown as Readonly<{
    authorizationCapability?: unknown;
    mode?: unknown;
  }>;
  if (
    !/^[a-z0-9-]+$/u.test(plan.diskQuota.allocationId) ||
    properties["User"] !== SYNTHETIC_SERVICE_USER ||
    properties["Group"] !== SYNTHETIC_SERVICE_USER ||
    properties["KillMode"] !== "control-group" ||
    properties["NoNewPrivileges"] !== true ||
    !Array.isArray(properties["AmbientCapabilities"]) ||
    properties["AmbientCapabilities"].length !== 0 ||
    !Array.isArray(properties["CapabilityBoundingSet"]) ||
    properties["CapabilityBoundingSet"].length !== 0 ||
    properties["DevicePolicy"] !== "closed" ||
    properties["ProtectSystem"] !== "strict" ||
    properties["ProtectControlGroups"] !== true ||
    properties["ProtectKernelModules"] !== true ||
    properties["ProtectKernelTunables"] !== true
  ) {
    throw new Error("sandbox_profile_relaxation_rejected");
  }
  const finiteSwap =
    typeof properties["MemorySwapMax"] === "bigint" &&
    properties["MemorySwapMax"] >= 0n &&
    swapPolicy.mode === "limited";
  const authorizedInfinity =
    properties["MemorySwapMax"] === "infinity" &&
    swapPolicy.mode === "infinity" &&
    swapPolicy.authorizationCapability === "memory_swap_infinity_authorized";
  if (!finiteSwap && !authorizedInfinity) {
    throw new Error("explicit_memory_swap_policy_required");
  }
  if (
    plan.diskQuota.maximumBytes <= 0n ||
    plan.diskQuota.inodeMaximum <= 0n ||
    !Number.isSafeInteger(plan.diskQuota.projectId) ||
    plan.diskQuota.projectId < 1 ||
    plan.diskQuota.root !==
      `/var/lib/workload-funnel/allocations/${plan.diskQuota.allocationId}` ||
    !plan.properties.ReadWritePaths.every(
      (root) =>
        root === plan.diskQuota.root ||
        root === `${plan.diskQuota.root}/output`,
    )
  ) {
    throw new Error("ephemeral_storage_control_mismatch");
  }
}

export function syntheticTransientUnit(
  unitName: string,
  controls: TransientExecutionControlPlan,
): SyntheticTransientUnit {
  assertUnitName(unitName);
  validateControlPlan(controls);
  return Object.freeze({
    description: "WorkloadFunnel Phase 4C synthetic process tree",
    execStart: Object.freeze([
      Object.freeze({
        arguments: Object.freeze([
          SYNTHETIC_EXECUTABLE,
          "--phase4c-tree",
        ] as const),
        ignoreFailure: false,
        path: SYNTHETIC_EXECUTABLE,
      }),
    ]) as SyntheticTransientUnit["execStart"],
    properties: Object.freeze({
      ...controls.properties,
      FinalKillSignal: "SIGKILL",
      KillSignal: "SIGTERM",
      ProtectHome: true,
      SendSIGKILL: true,
      TimeoutStopUSec: 5_000_000,
      WorkingDirectory: SYNTHETIC_WORKING_DIRECTORY,
    }),
    startMode: "fail",
    unitName,
  });
}

export function startSyntheticTransientUnit(
  manager: TransientUnitStartManager,
  unitName: string,
  mutationFence: MutationFence,
  controls: TransientExecutionControlPlan,
): TransientUnitStartResult {
  if (manager.transientServiceStart !== "supported") {
    return {
      evidence: "systemd_transient_service_start_unsupported",
      status: "unsupported",
    };
  }
  if (manager.projectQuotaControl !== "supported") {
    return {
      evidence: "ephemeral_project_quota_unsupported",
      status: "unsupported",
    };
  }
  validateMutationFence(mutationFence);
  if (mutationFence.desiredEffect !== "process_start") {
    throw new Error("transient_unit_start_fence_mismatch");
  }
  const unit = syntheticTransientUnit(unitName, controls);
  const quotaReceipt = manager.applyProjectQuota(controls.diskQuota);
  if (
    !isExactProjectQuotaReceipt(controls.diskQuota, quotaReceipt) ||
    !manager.verifyProjectQuotaReceipt(controls.diskQuota, quotaReceipt)
  ) {
    throw new Error("project_quota_receipt_verification_failed");
  }
  manager.startTransientService(unit);
  return { status: "started", unitName };
}
