import { describe, expect, it, vi } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";
import {
  discoverSystemdCapabilities,
  syntheticDisposableLinuxProbe,
} from "@workload-funnel/executor-systemd/capability-discovery";
import {
  createSyntheticSandboxProfile,
  mapSystemdExecutionControls,
} from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import { stopSyntheticTransientUnit } from "@workload-funnel/executor-systemd/transient-unit-cancellation";
import {
  startSyntheticTransientUnit,
  fingerprintProjectQuotaControl,
  PROJECT_QUOTA_RECEIPT_SCHEMA,
  type TransientProjectQuotaControl,
  type TransientUnitStartManager,
} from "@workload-funnel/executor-systemd/transient-unit-start";

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

function controls() {
  const result = mapSystemdExecutionControls(
    createSyntheticSandboxProfile("allocation-1"),
    discoverSystemdCapabilities(syntheticDisposableLinuxProbe()),
    "synthetic_disposable_linux_fixture",
  );
  if (result.status === "unsupported") throw new Error(result.reason);
  return result;
}

describe("systemd final MutationFence boundaries", () => {
  it("makes no manager call when the real execution mutation receives the wrong effect", () => {
    const start = vi.fn(() => "created" as const);
    const manager: TransientUnitStartManager = {
      applyProjectQuota: vi.fn((control: TransientProjectQuotaControl) => ({
        ...control,
        controlDigest: fingerprintProjectQuotaControl(control),
        registryRevision: 1,
        schemaVersion: PROJECT_QUOTA_RECEIPT_SCHEMA,
        status: "applied" as const,
        verification: "exact_root_and_limits" as const,
      })),
      projectQuotaControl: "supported",
      startTransientService: start,
      transientServiceStart: "supported",
      verifyProjectQuotaReceipt: vi.fn(() => true),
    };
    const unitName =
      "workload-funnel-phase4a-0123456789abcdef0123456789abcdef.service";

    expect(
      startSyntheticTransientUnit(manager, unitName, startFence(), controls()),
    ).toMatchObject({ status: "started" });
    expect(start).toHaveBeenCalledOnce();

    const {
      issuedStartRevocationRevision: _issuedStartRevocationRevision,
      startFence: _startFence,
      ...stopFence
    } = startFence();
    void _issuedStartRevocationRevision;
    void _startFence;
    expect(() =>
      startSyntheticTransientUnit(
        manager,
        unitName,
        {
          ...stopFence,
          desiredEffect: "process_stop",
        },
        controls(),
      ),
    ).toThrow("transient_unit_start_fence_mismatch");
    expect(start).toHaveBeenCalledOnce();
  });

  it("requires an explicit stop class before the control-group mutation", () => {
    const stop = vi.fn(() => "stopped" as const);
    const manager = {
      controlGroupStop: "supported" as const,
      stopTransientService: stop,
    };
    expect(() =>
      stopSyntheticTransientUnit(
        manager,
        "workload-funnel-phase4a-0123456789abcdef0123456789abcdef.service",
        startFence(),
        "fenced_stop",
      ),
    ).toThrow("transient_unit_cancellation_fence_mismatch");
    expect(stop).not.toHaveBeenCalled();
  });
});
