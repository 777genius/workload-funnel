import { describe, expect, it } from "vitest";

import {
  decideHostControlAdmission,
  decideSandboxAdmission,
  hardIsolationCapabilitiesForDelegatedWork,
  type CapabilityName,
  type HostControlAdmissionContext,
} from "../index.js";

const baseline: HostControlAdmissionContext = Object.freeze({
  attribution: "per_allocation",
  daemonPoolReserved: true,
  deploymentAllowsDirectHostSocket: false,
  elevatedAuthorization: false,
  requestedByCallerOverride: false,
  tenantIsolation: "multi_tenant",
  workloadTrust: "trusted",
  verifiedIsolationProfiles: new Map(),
});

describe("Phase 4C daemon-mediated host-control restrictions", () => {
  it("keeps direct host sockets disabled by default and unavailable to caller override", () => {
    expect(decideHostControlAdmission("direct_host_socket", baseline)).toEqual({
      mode: "direct_host_socket",
      reason: "direct_host_socket_disabled",
      status: "unschedulable_host_control",
    });
    expect(
      decideHostControlAdmission("typed_broker", {
        ...baseline,
        requestedByCallerOverride: true,
      }),
    ).toMatchObject({
      reason: "caller_override_forbidden",
      status: "unschedulable_host_control",
    });
  });

  it("permits the elevated direct pattern only on an explicitly enabled single-tenant host", () => {
    expect(
      decideHostControlAdmission("direct_host_socket", {
        ...baseline,
        deploymentAllowsDirectHostSocket: true,
        elevatedAuthorization: true,
        tenantIsolation: "single_tenant",
      }),
    ).toEqual({ mode: "direct_host_socket", status: "allowed" });
    expect(
      decideHostControlAdmission("direct_host_socket", {
        ...baseline,
        deploymentAllowsDirectHostSocket: true,
        elevatedAuthorization: true,
      }),
    ).toMatchObject({ reason: "multi_tenant_host_control_forbidden" });
  });

  it("makes an unsupported SandboxProfile typed unschedulable", () => {
    const available = new Set<CapabilityName>([
      "hard_cpu_enforcement",
      "sandbox_trusted_process_baseline",
    ]);
    expect(
      decideSandboxAdmission(
        {
          hostControlMode: "typed_broker",
          profileId: "build-broker-v1",
          requiredCapabilities: [
            "hard_cpu_enforcement",
            "hard_memory_enforcement",
            "sandbox_trusted_process_baseline",
          ],
          trustedProcessOnly: true,
        },
        available,
        baseline,
      ),
    ).toEqual({
      capabilityDecision: {
        missingCapabilities: [
          "hard_memory_enforcement",
          "host_control_typed_broker",
        ],
        status: "unschedulable_missing_capability",
      },
      hostControlDecision: { mode: "typed_broker", status: "allowed" },
      status: "unschedulable_sandbox_profile",
      trustDecision: { status: "allowed" },
    });
  });

  it("removes hard per-workload claims for unattributed delegated daemon work", () => {
    const advertised = new Set<CapabilityName>([
      "hard_cpu_enforcement",
      "hard_memory_enforcement",
      "local_dispatch",
      "process_tree_cancellation",
    ]);
    expect([
      ...hardIsolationCapabilitiesForDelegatedWork(advertised, "unattributed"),
    ]).toEqual(["local_dispatch"]);
    expect(
      hardIsolationCapabilitiesForDelegatedWork(advertised, "per_allocation"),
    ).toEqual(advertised);
  });

  it("requires separately reserved daemon capacity and exact attribution", () => {
    expect(
      decideHostControlAdmission("rootless_per_allocation", {
        ...baseline,
        daemonPoolReserved: false,
      }),
    ).toMatchObject({ reason: "daemon_capacity_unreserved" });
    expect(
      decideHostControlAdmission("typed_broker", {
        ...baseline,
        attribution: "shared_pool",
      }),
    ).toMatchObject({ reason: "hard_attribution_unavailable" });
  });

  it("keeps arbitrary untrusted code unschedulable on the trusted-process profile", () => {
    const available = new Set<CapabilityName>([
      "hard_memory_enforcement",
      "sandbox_trusted_process_baseline",
    ]);
    expect(
      decideSandboxAdmission(
        {
          hostControlMode: "denied",
          profileId: "trusted-process-v1",
          requiredCapabilities: [
            "hard_memory_enforcement",
            "sandbox_trusted_process_baseline",
          ],
          trustedProcessOnly: true,
        },
        available,
        { ...baseline, workloadTrust: "untrusted" },
      ),
    ).toMatchObject({
      status: "unschedulable_sandbox_profile",
      trustDecision: {
        reason: "untrusted_code_requires_stronger_isolation",
        status: "unschedulable_untrusted_profile",
      },
    });
  });

  it("does not treat trustedProcessOnly=false as untrusted isolation", () => {
    expect(
      decideSandboxAdmission(
        {
          hostControlMode: "denied",
          profileId: "boolean-only-v1",
          requiredCapabilities: [],
          trustedProcessOnly: false,
        },
        new Set(),
        { ...baseline, workloadTrust: "untrusted" },
      ),
    ).toMatchObject({
      status: "unschedulable_sandbox_profile",
      trustDecision: { status: "unschedulable_untrusted_profile" },
    });
  });

  it("requires an available capability and exact verified stronger profile", () => {
    const digest = "a".repeat(64);
    const profile = {
      hostControlMode: "denied" as const,
      profileId: "untrusted-vm-v1",
      requiredCapabilities: [] as readonly CapabilityName[],
      strongerUntrustedIsolation: {
        capability: "strong_untrusted_workload_isolation" as const,
        profileDigest: digest,
        profileId: "microvm-v1",
      },
      trustedProcessOnly: false,
    };
    const untrusted = { ...baseline, workloadTrust: "untrusted" as const };

    expect(
      decideSandboxAdmission(profile, new Set(), {
        ...untrusted,
        verifiedIsolationProfiles: new Map([["microvm-v1", digest]]),
      }),
    ).toMatchObject({ status: "unschedulable_sandbox_profile" });
    expect(
      decideSandboxAdmission(
        profile,
        new Set(["strong_untrusted_workload_isolation"]),
        {
          ...untrusted,
          verifiedIsolationProfiles: new Map([["microvm-v1", "b".repeat(64)]]),
        },
      ),
    ).toMatchObject({
      status: "unschedulable_sandbox_profile",
      trustDecision: { status: "unschedulable_untrusted_profile" },
    });
    expect(
      decideSandboxAdmission(
        profile,
        new Set(["strong_untrusted_workload_isolation"]),
        {
          ...untrusted,
          verifiedIsolationProfiles: new Map([["microvm-v1", digest]]),
        },
      ),
    ).toMatchObject({
      status: "satisfied",
      trustDecision: { status: "allowed" },
    });
  });
});
