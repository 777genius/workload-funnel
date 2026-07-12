import {
  CapabilityRequirement,
  type CapabilityName,
} from "./capability-requirement.js";
import {
  decideCapabilityAdmission,
  type CapabilityAdmissionDecision,
} from "./capability-admission-policy.js";

export type HostControlMode =
  | "dedicated_node"
  | "denied"
  | "direct_host_socket"
  | "rootless_per_allocation"
  | "typed_broker";

export interface SandboxAdmissionProfile {
  readonly hostControlMode: HostControlMode;
  readonly profileId: string;
  readonly requiredCapabilities: readonly CapabilityName[];
  readonly strongerUntrustedIsolation?: Readonly<{
    readonly capability: "strong_untrusted_workload_isolation";
    readonly profileDigest: string;
    readonly profileId: string;
  }>;
  readonly trustedProcessOnly: boolean;
}

export interface HostControlAdmissionContext {
  readonly attribution: "per_allocation" | "shared_pool" | "unattributed";
  readonly daemonPoolReserved: boolean;
  readonly deploymentAllowsDirectHostSocket: boolean;
  readonly elevatedAuthorization: boolean;
  readonly requestedByCallerOverride: boolean;
  readonly tenantIsolation: "multi_tenant" | "single_tenant";
  readonly workloadTrust: "trusted" | "untrusted";
  readonly verifiedIsolationProfiles: ReadonlyMap<string, string>;
}

export type HostControlAdmissionDecision = Readonly<
  | { mode: HostControlMode; status: "allowed" }
  | {
      mode: HostControlMode;
      reason:
        | "caller_override_forbidden"
        | "daemon_capacity_unreserved"
        | "direct_host_socket_disabled"
        | "hard_attribution_unavailable"
        | "host_control_denied"
        | "multi_tenant_host_control_forbidden"
        | "privileged_authorization_required";
      status: "unschedulable_host_control";
    }
>;

export interface SandboxAdmissionDecision {
  readonly capabilityDecision: CapabilityAdmissionDecision;
  readonly hostControlDecision: HostControlAdmissionDecision;
  readonly status: "satisfied" | "unschedulable_sandbox_profile";
  readonly trustDecision: Readonly<
    | { status: "allowed" }
    | {
        reason: "untrusted_code_requires_stronger_isolation";
        status: "unschedulable_untrusted_profile";
      }
  >;
}

export function decideHostControlAdmission(
  mode: HostControlMode,
  context: HostControlAdmissionContext,
): HostControlAdmissionDecision {
  if (mode === "denied") {
    return Object.freeze({ mode, status: "allowed" });
  }
  if (context.requestedByCallerOverride) {
    return Object.freeze({
      mode,
      reason: "caller_override_forbidden",
      status: "unschedulable_host_control",
    });
  }
  if (!context.daemonPoolReserved) {
    return Object.freeze({
      mode,
      reason: "daemon_capacity_unreserved",
      status: "unschedulable_host_control",
    });
  }
  if (
    (mode === "rootless_per_allocation" || mode === "typed_broker") &&
    context.attribution !== "per_allocation"
  ) {
    return Object.freeze({
      mode,
      reason: "hard_attribution_unavailable",
      status: "unschedulable_host_control",
    });
  }
  if (mode === "direct_host_socket") {
    if (!context.deploymentAllowsDirectHostSocket) {
      return Object.freeze({
        mode,
        reason: "direct_host_socket_disabled",
        status: "unschedulable_host_control",
      });
    }
    if (!context.elevatedAuthorization) {
      return Object.freeze({
        mode,
        reason: "privileged_authorization_required",
        status: "unschedulable_host_control",
      });
    }
    if (context.tenantIsolation !== "single_tenant") {
      return Object.freeze({
        mode,
        reason: "multi_tenant_host_control_forbidden",
        status: "unschedulable_host_control",
      });
    }
  }
  if (
    mode === "dedicated_node" &&
    context.tenantIsolation !== "single_tenant"
  ) {
    return Object.freeze({
      mode,
      reason: "multi_tenant_host_control_forbidden",
      status: "unschedulable_host_control",
    });
  }
  return Object.freeze({ mode, status: "allowed" });
}

const hostControlCapabilities: Readonly<
  Partial<Record<HostControlMode, CapabilityName>>
> = Object.freeze({
  dedicated_node: "host_control_dedicated_node",
  direct_host_socket: "host_control_direct_socket",
  rootless_per_allocation: "host_control_rootless_per_allocation",
  typed_broker: "host_control_typed_broker",
});

export function decideSandboxAdmission(
  profile: SandboxAdmissionProfile,
  availableCapabilities: ReadonlySet<CapabilityName>,
  context: HostControlAdmissionContext,
): SandboxAdmissionDecision {
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(profile.profileId)) {
    throw new Error("invalid_sandbox_admission_profile_id");
  }
  const hostCapability = hostControlCapabilities[profile.hostControlMode];
  const strongerIsolation = profile.strongerUntrustedIsolation;
  if (
    strongerIsolation !== undefined &&
    (!/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(strongerIsolation.profileId) ||
      !/^[a-f0-9]{64}$/u.test(strongerIsolation.profileDigest))
  ) {
    throw new Error("invalid_stronger_isolation_profile_binding");
  }
  const required = [
    ...profile.requiredCapabilities,
    ...(hostCapability === undefined ? [] : [hostCapability]),
    ...(strongerIsolation === undefined ? [] : [strongerIsolation.capability]),
  ].map((name) => CapabilityRequirement.from(name));
  const capabilityDecision = decideCapabilityAdmission(
    required,
    availableCapabilities,
  );
  const hostControlDecision: HostControlAdmissionDecision =
    profile.hostControlMode === "direct_host_socket" &&
    !profile.trustedProcessOnly
      ? Object.freeze({
          mode: profile.hostControlMode,
          reason: "host_control_denied",
          status: "unschedulable_host_control",
        })
      : decideHostControlAdmission(profile.hostControlMode, context);
  const verifiedStrongerIsolation =
    !profile.trustedProcessOnly &&
    strongerIsolation !== undefined &&
    context.verifiedIsolationProfiles.get(strongerIsolation.profileId) ===
      strongerIsolation.profileDigest;
  const trustDecision: SandboxAdmissionDecision["trustDecision"] =
    context.workloadTrust === "untrusted" && !verifiedStrongerIsolation
      ? Object.freeze({
          reason: "untrusted_code_requires_stronger_isolation",
          status: "unschedulable_untrusted_profile",
        })
      : Object.freeze({ status: "allowed" });
  return Object.freeze({
    capabilityDecision,
    hostControlDecision,
    status:
      capabilityDecision.status === "satisfied" &&
      hostControlDecision.status === "allowed" &&
      trustDecision.status === "allowed"
        ? "satisfied"
        : "unschedulable_sandbox_profile",
    trustDecision,
  });
}

export function hardIsolationCapabilitiesForDelegatedWork(
  capabilities: ReadonlySet<CapabilityName>,
  attribution: HostControlAdmissionContext["attribution"],
): ReadonlySet<CapabilityName> {
  if (attribution === "per_allocation") return new Set(capabilities);
  const hardClaims = new Set<CapabilityName>([
    "hard_cpu_enforcement",
    "hard_ephemeral_disk_enforcement",
    "hard_io_enforcement",
    "hard_memory_enforcement",
    "pid_containment",
    "process_tree_cancellation",
  ]);
  return new Set([...capabilities].filter((name) => !hardClaims.has(name)));
}
