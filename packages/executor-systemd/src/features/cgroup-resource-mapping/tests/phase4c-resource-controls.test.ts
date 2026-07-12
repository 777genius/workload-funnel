import { describe, expect, it, vi } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";
import {
  discoverSystemdCapabilities,
  syntheticDisposableLinuxProbe,
} from "@workload-funnel/executor-systemd/capability-discovery";
import {
  createSyntheticHostSurvivalProfile,
  createSyntheticSandboxProfile,
  deterministicProjectQuotaId,
  mapHostSurvivalControls,
  mapSystemdExecutionControls,
} from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import {
  startSyntheticTransientUnit,
  fingerprintProjectQuotaControl,
  PROJECT_QUOTA_RECEIPT_SCHEMA,
  type SyntheticTransientUnit,
  type TransientProjectQuotaControl,
  type TransientUnitStartManager,
  type VerifiedProjectQuotaReceipt,
} from "@workload-funnel/executor-systemd/transient-unit-start";
import {
  fingerprintSandboxProfile,
  evaluateStorageHeadroom,
  validateHostSurvivalProfile,
  type ResourceEnforcementCapability,
} from "@workload-funnel/node-execution/resource-enforcement";

function startFence(): MutationFence {
  return {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "process:attempt-1:generation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "process:attempt-1:generation-1",
  };
}

function supportedPlan() {
  const profile = createSyntheticSandboxProfile("allocation-1");
  const decision = mapSystemdExecutionControls(
    profile,
    discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
    "synthetic_disposable_linux_fixture",
  );
  if (decision.status === "unsupported") throw new Error(decision.reason);
  return { decision, profile };
}

function quotaReceipt(
  control: TransientProjectQuotaControl,
): VerifiedProjectQuotaReceipt {
  return {
    ...control,
    controlDigest: fingerprintProjectQuotaControl(control),
    registryRevision: 1,
    schemaVersion: PROJECT_QUOTA_RECEIPT_SCHEMA,
    status: "applied",
    verification: "exact_root_and_limits",
  };
}

describe("Phase 4C exact resource and sandbox mapping", () => {
  it("maps every granted limit to exact systemd and project-quota controls", () => {
    const { decision, profile } = supportedPlan();

    expect(decision.profileDigest).toBe(fingerprintSandboxProfile(profile));
    expect(decision.properties).toEqual({
      AmbientCapabilities: [],
      CapabilityBoundingSet: [],
      CPUQuotaPerSecUSec: 500_000n,
      CPUWeight: 100,
      DevicePolicy: "closed",
      Group: "workload-funnel-synthetic",
      IOReadBandwidthMax: [["/dev/workload-funnel-test", 16_777_216n]],
      IOWeight: 100,
      IOWriteBandwidthMax: [["/dev/workload-funnel-test", 8_388_608n]],
      KillMode: "control-group",
      LimitNOFILE: 1_024,
      MemoryHigh: 134_217_728n,
      MemoryMax: 201_326_592n,
      MemorySwapMax: 0n,
      NoNewPrivileges: true,
      PrivateDevices: true,
      PrivateNetwork: true,
      PrivateTmp: true,
      ProtectControlGroups: true,
      ProtectKernelModules: true,
      ProtectKernelTunables: true,
      ProtectSystem: "strict",
      ReadWritePaths: [
        "/var/lib/workload-funnel/allocations/allocation-1",
        "/var/lib/workload-funnel/allocations/allocation-1/output",
      ],
      RuntimeMaxUSec: 300_000_000n,
      SystemCallFilter: [
        "@system-service",
        "~@mount",
        "~@privileged",
        "~@resources",
      ],
      TasksMax: 64,
      User: "workload-funnel-synthetic",
    });
    expect(decision.diskQuota).toEqual({
      allocationId: "allocation-1",
      inodeMaximum: 4_096n,
      maximumBytes: 67_108_864n,
      projectId: deterministicProjectQuotaId("allocation-1"),
      root: "/var/lib/workload-funnel/allocations/allocation-1",
    });
  });

  it("refuses every unavailable required capability without a fallback", () => {
    const profile = createSyntheticSandboxProfile("allocation-1");
    const supported = discoverSystemdCapabilities(
      syntheticDisposableLinuxProbe(),
    );
    for (const capability of profile.requiredCapabilities) {
      const report = {
        ...supported,
        capabilities: { ...supported.capabilities, [capability]: false },
      };
      expect(
        mapSystemdExecutionControls(
          profile,
          report,
          "synthetic_disposable_linux_fixture",
        ),
      ).toEqual({
        missingCapabilities: [capability],
        reason: "unsupported_profile_capability",
        status: "unsupported",
      });
    }
  });

  it("rejects a profile that omits a capability implied by its controls", () => {
    const profile = createSyntheticSandboxProfile("allocation-1");
    expect(() =>
      mapSystemdExecutionControls(
        {
          ...profile,
          requiredCapabilities: profile.requiredCapabilities.filter(
            (capability) => capability !== "memory_max",
          ),
        },
        discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
        "synthetic_disposable_linux_fixture",
      ),
    ).toThrow("sandbox_profile_omits_required_capability");
  });

  it("keeps production disabled even when every synthetic probe passes", () => {
    const decision = mapSystemdExecutionControls(
      createSyntheticSandboxProfile("allocation-1"),
      discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
      "production",
    );
    expect(decision).toEqual({
      missingCapabilities: [],
      reason: "production_start_disabled",
      status: "unsupported",
    });
  });

  it("requires exact byte and inode quota before the systemd call", () => {
    const { decision } = supportedPlan();
    const quota = vi.fn(quotaReceipt);
    const start = vi.fn<(unit: SyntheticTransientUnit) => "created">(
      () => "created",
    );
    const manager: TransientUnitStartManager = {
      applyProjectQuota: quota,
      projectQuotaControl: "supported",
      startTransientService: start,
      transientServiceStart: "supported",
      verifyProjectQuotaReceipt: vi.fn(() => true),
    };

    expect(
      startSyntheticTransientUnit(
        manager,
        "workload-funnel-phase4a-0123456789abcdef0123456789abcdef.service",
        startFence(),
        decision,
      ),
    ).toMatchObject({ status: "started" });
    expect(quota).toHaveBeenCalledWith(decision.diskQuota);
    expect(quota.mock.invocationCallOrder[0]).toBeLessThan(
      start.mock.invocationCallOrder[0] ?? 0,
    );
    const unit = start.mock.calls[0]?.[0];
    expect(unit?.properties).toMatchObject({
      FinalKillSignal: "SIGKILL",
      KillMode: "control-group",
      SendSIGKILL: true,
      TasksMax: 64,
    });
  });

  it("uses deterministic per-allocation project IDs", () => {
    const first = supportedPlan().decision.diskQuota;
    const secondProfile = createSyntheticSandboxProfile("allocation-2");
    const secondDecision = mapSystemdExecutionControls(
      secondProfile,
      discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
      "synthetic_disposable_linux_fixture",
    );
    if (secondDecision.status === "unsupported") {
      throw new Error(secondDecision.reason);
    }
    expect(first.projectId).toBe(deterministicProjectQuotaId("allocation-1"));
    expect(secondDecision.diskQuota.projectId).toBe(
      deterministicProjectQuotaId("allocation-2"),
    );
    expect(secondDecision.diskQuota.projectId).not.toBe(first.projectId);
  });

  it("rejects a mismatched quota receipt before the systemd call", () => {
    const { decision } = supportedPlan();
    const start = vi.fn<(unit: SyntheticTransientUnit) => "created">(
      () => "created",
    );
    const manager: TransientUnitStartManager = {
      applyProjectQuota: (control) => ({
        ...quotaReceipt(control),
        root: "/var/lib/workload-funnel/allocations/forged",
      }),
      projectQuotaControl: "supported",
      startTransientService: start,
      transientServiceStart: "supported",
      verifyProjectQuotaReceipt: () => true,
    };

    expect(() =>
      startSyntheticTransientUnit(
        manager,
        "workload-funnel-phase4a-0123456789abcdef0123456789abcdef.service",
        startFence(),
        decision,
      ),
    ).toThrow("project_quota_receipt_verification_failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("makes zero quota and systemd calls when disk enforcement is unavailable", () => {
    const { decision } = supportedPlan();
    const quota = vi.fn(quotaReceipt);
    const start = vi.fn<(unit: SyntheticTransientUnit) => "created">(
      () => "created",
    );
    const manager: TransientUnitStartManager = {
      applyProjectQuota: quota,
      projectQuotaControl: "unsupported",
      startTransientService: start,
      transientServiceStart: "supported",
      verifyProjectQuotaReceipt: vi.fn(() => true),
    };

    expect(
      startSyntheticTransientUnit(
        manager,
        "workload-funnel-phase4a-0123456789abcdef0123456789abcdef.service",
        startFence(),
        decision,
      ),
    ).toEqual({
      evidence: "ephemeral_project_quota_unsupported",
      status: "unsupported",
    });
    expect(quota).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects an omitted swap policy instead of inheriting the host default", () => {
    const profile = createSyntheticSandboxProfile("allocation-1");
    const memoryWithoutSwap = {
      highBytes: profile.resources.memory.highBytes,
      maximumBytes: profile.resources.memory.maximumBytes,
    };
    expect(() =>
      mapSystemdExecutionControls(
        {
          ...profile,
          resources: {
            ...profile.resources,
            memory: memoryWithoutSwap,
          },
        } as unknown as typeof profile,
        discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
        "synthetic_disposable_linux_fixture",
      ),
    ).toThrow("explicit_memory_swap_policy_required");
  });

  it("allows infinity only when the profile and capability explicitly authorize it", () => {
    const baseline = createSyntheticSandboxProfile("allocation-1");
    const profile = {
      ...baseline,
      requiredCapabilities: [
        ...baseline.requiredCapabilities,
        "memory_swap_infinity_authorized" as const,
      ],
      resources: {
        ...baseline.resources,
        memory: {
          ...baseline.resources.memory,
          swap: {
            authorization: "explicit" as const,
            mode: "infinity" as const,
            requiredCapability: "memory_swap_infinity_authorized" as const,
          },
        },
      },
    };
    expect(
      mapSystemdExecutionControls(
        profile,
        discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
        "synthetic_disposable_linux_fixture",
      ),
    ).toMatchObject({
      missingCapabilities: ["memory_swap_infinity_authorized"],
      status: "unsupported",
    });
    const authorized = discoverSystemdCapabilities({
      ...syntheticDisposableLinuxProbe(),
      authorizedUnlimitedSwap: true,
    });
    expect(
      mapSystemdExecutionControls(
        profile,
        authorized,
        "synthetic_disposable_linux_fixture",
      ),
    ).toMatchObject({
      properties: { MemorySwapMax: "infinity" },
      status: "supported",
    });
  });

  it("protects the control slice ahead of the workload OOM candidate", () => {
    const profile = createSyntheticHostSurvivalProfile();
    const controls = mapHostSurvivalControls(
      profile,
      discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
    );
    if (controls.status === "unsupported") {
      throw new Error(controls.missingCapabilities.join(","));
    }

    expect(controls.controlSlice).toMatchObject({
      CPUWeight: 10_000,
      IOWeight: 10_000,
      ManagedOOMMemoryPressure: "avoid",
      MemoryLow: 268_435_456n,
      MemoryMin: 134_217_728n,
      OOMPolicy: "continue",
      OOMScoreAdjust: -900,
    });
    expect(controls.workloadSlice).toMatchObject({
      CPUWeight: 100,
      IOWeight: 100,
      ManagedOOMMemoryPressure: "kill",
      OOMPolicy: "stop",
    });
    expect(controls.storageHeadroom).toHaveLength(7);
    expect(
      evaluateStorageHeadroom(
        profile,
        profile.storageHeadroom.map((required) => ({
          class: required.class,
          freeBytes: required.minimumFreeBytes + 1n,
          freeInodes: required.minimumFreeInodes + 1n,
        })),
      ),
    ).toEqual({ status: "satisfied" });
    expect(
      evaluateStorageHeadroom(
        profile,
        profile.storageHeadroom
          .filter((required) => required.class !== "launcher_wal")
          .map((required) => ({
            class: required.class,
            freeBytes: required.minimumFreeBytes + 1n,
            freeInodes: required.minimumFreeInodes + 1n,
          })),
      ),
    ).toEqual({
      exhaustedClasses: ["launcher_wal"],
      status: "critical",
    });
    expect(() => {
      validateHostSurvivalProfile({
        ...profile,
        controlSlice: { ...profile.controlSlice, oomScoreAdjust: 0 },
      });
    }).toThrow("control_slice_must_be_oom_protected");
    expect(
      mapHostSurvivalControls(profile, {
        ...discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
        capabilities: {
          ...discoverSystemdCapabilities(syntheticDisposableLinuxProbe())
            .capabilities,
          systemd_managed_oom: false,
        },
      }),
    ).toEqual({
      missingCapabilities: ["systemd_managed_oom"],
      status: "unsupported",
    });
  });

  it("reports pinned paths unsupported instead of relabeling cgroups as isolation", () => {
    const report = discoverSystemdCapabilities(syntheticDisposableLinuxProbe());
    const profile = createSyntheticSandboxProfile("allocation-1");
    const requiringPinnedPaths = {
      ...profile,
      isolation: { ...profile.isolation, requiresPinnedExecutionPaths: true },
      requiredCapabilities: [
        ...profile.requiredCapabilities,
        "pinned_execution_paths" as ResourceEnforcementCapability,
      ],
    };
    expect(
      mapSystemdExecutionControls(
        requiringPinnedPaths,
        report,
        "synthetic_disposable_linux_fixture",
      ),
    ).toMatchObject({
      missingCapabilities: ["pinned_execution_paths"],
      status: "unsupported",
    });
  });

  it("does not report Linux-only controls on a non-Linux probe", () => {
    const report = discoverSystemdCapabilities({
      ...syntheticDisposableLinuxProbe(),
      linux: false,
      pinnedExecutionPaths: true,
    });
    expect(report.capabilities).toMatchObject({
      ephemeral_disk_inode_quota: false,
      ephemeral_disk_quota: false,
      pinned_execution_paths: false,
      storage_headroom_enforcement: false,
      systemd_transient_service: false,
    });
  });
});
