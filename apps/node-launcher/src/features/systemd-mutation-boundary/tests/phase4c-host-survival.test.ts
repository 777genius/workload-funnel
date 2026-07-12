import { describe, expect, it } from "vitest";

import {
  discoverSystemdCapabilities,
  syntheticDisposableLinuxProbe,
} from "@workload-funnel/executor-systemd/capability-discovery";
import {
  createSyntheticSandboxProfile,
  deterministicProjectQuotaId,
  mapSystemdExecutionControls,
} from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import { parseLauncherRpcResponse } from "@workload-funnel/node-execution/process-lifecycle";

import {
  SyntheticSystemdManager,
  agentPeer,
  fixture,
  request,
  signedTicket,
  ticketClaims,
} from "./phase4b-launcher-fixture.js";

describe("Phase 4C disposable synthetic Linux launcher surface", () => {
  it("applies the immutable signed SandboxProfile and exact controls", () => {
    const current = fixture();
    const response = parseLauncherRpcResponse(
      current.boundary.handle(
        request(signedTicket(current), "phase4c-exact-controls"),
        agentPeer,
      ),
    );

    expect(response).toMatchObject({ ok: true, result: { state: "started" } });
    expect(current.manager.quotas).toEqual([
      {
        allocationId: "allocation-1",
        inodeMaximum: 4_096n,
        maximumBytes: 67_108_864n,
        projectId: deterministicProjectQuotaId("allocation-1"),
        root: "/var/lib/workload-funnel/allocations/allocation-1",
      },
    ]);
    expect(current.manager.starts[0]?.properties).toMatchObject({
      CPUQuotaPerSecUSec: 500_000n,
      CPUWeight: 100,
      IOReadBandwidthMax: [["/dev/workload-funnel-test", 16_777_216n]],
      IOWriteBandwidthMax: [["/dev/workload-funnel-test", 8_388_608n]],
      MemoryHigh: 134_217_728n,
      MemoryMax: 201_326_592n,
      MemorySwapMax: 0n,
      PrivateNetwork: true,
      TasksMax: 64,
    });
  });

  it("rejects a signed profile digest mismatch before quota or systemd mutation", () => {
    const current = fixture();
    const mismatched = signedTicket(current, {
      ...ticketClaims(),
      sandboxProfileDigest: "0".repeat(64),
    });

    for (const method of ["start", "observe", "stop"] as const) {
      expect(
        parseLauncherRpcResponse(
          current.boundary.handle(
            request(mismatched, `profile-digest-mismatch-${method}`, method),
            agentPeer,
          ),
        ),
      ).toMatchObject({ error: { code: "ticket_rejected" }, ok: false });
    }
    expect(current.manager.quotas).toHaveLength(0);
    expect(current.manager.starts).toHaveLength(0);
  });

  it("makes unsupported isolation unschedulable with zero host mutation", () => {
    const supported = discoverSystemdCapabilities(
      syntheticDisposableLinuxProbe(),
    );
    const manager = new SyntheticSystemdManager(false, {
      ...supported,
      capabilities: { ...supported.capabilities, memory_max: false },
    });
    const current = fixture(undefined, manager);
    const walRecordsBefore = current.storage.readAll().length;

    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "missing-memory-max"),
          agentPeer,
        ),
      ),
    ).toEqual({
      error: {
        code: "unsupported_host_capability",
        message: "memory_max",
      },
      ok: false,
      protocolVersion: "phase4a.launcher-rpc.v1",
      requestId: "missing-memory-max",
    });
    expect(current.storage.readAll()).toHaveLength(walRecordsBefore);
    expect(manager.quotas).toHaveLength(0);
    expect(manager.starts).toHaveLength(0);
  });

  it("refuses unavailable disk quota before nonce redemption", () => {
    const manager = new SyntheticSystemdManager();
    Object.defineProperty(manager, "projectQuotaControl", {
      value: "unsupported",
    });
    const current = fixture(undefined, manager);
    const walRecordsBefore = current.storage.readAll().length;

    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "missing-project-quota"),
          agentPeer,
        ),
      ),
    ).toMatchObject({
      error: {
        code: "unsupported_host_capability",
        message: "ephemeral_project_quota_unsupported",
      },
      ok: false,
    });
    expect(current.storage.readAll()).toHaveLength(walRecordsBefore);
    expect(manager.quotas).toHaveLength(0);
    expect(manager.starts).toHaveLength(0);
  });

  it.each(["collision", "mismatch"] as const)(
    "fails a quota %s before any systemd start mutation",
    (failureMode) => {
      const manager = new SyntheticSystemdManager();
      const controls = mapSystemdExecutionControls(
        createSyntheticSandboxProfile("allocation-1"),
        manager.resourceCapabilities,
        "synthetic_disposable_linux_fixture",
      );
      if (controls.status === "unsupported") throw new Error(controls.reason);
      manager.applyProjectQuota(
        failureMode === "collision"
          ? {
              ...controls.diskQuota,
              allocationId: "allocation-2",
              root: "/var/lib/workload-funnel/allocations/allocation-2",
            }
          : {
              ...controls.diskQuota,
              maximumBytes: controls.diskQuota.maximumBytes + 1n,
            },
      );
      const current = fixture(undefined, manager);

      expect(
        parseLauncherRpcResponse(
          current.boundary.handle(
            request(signedTicket(current), `quota-${failureMode}`),
            agentPeer,
          ),
        ),
      ).toMatchObject({
        error: { code: "unsupported_host_capability" },
        ok: false,
      });
      expect(manager.quotas).toHaveLength(1);
      expect(manager.starts).toHaveLength(0);
    },
  );

  it("starts only after an existing quota is verified as an exact match", () => {
    const manager = new SyntheticSystemdManager();
    const controls = mapSystemdExecutionControls(
      createSyntheticSandboxProfile("allocation-1"),
      manager.resourceCapabilities,
      "synthetic_disposable_linux_fixture",
    );
    if (controls.status === "unsupported") throw new Error(controls.reason);
    expect(manager.applyProjectQuota(controls.diskQuota).status).toBe(
      "applied",
    );
    expect(manager.applyProjectQuota(controls.diskQuota).status).toBe(
      "verified_existing",
    );
    const current = fixture(undefined, manager);

    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "verified-existing-quota"),
          agentPeer,
        ),
      ),
    ).toMatchObject({ ok: true, result: { state: "started" } });
    expect(manager.quotas).toHaveLength(1);
    expect(manager.starts).toHaveLength(1);
  });

  it("rejects a stale quota receipt before any systemd start mutation", () => {
    const manager = new SyntheticSystemdManager();
    manager.returnStaleQuotaReceipt = true;
    const current = fixture(undefined, manager);

    expect(
      parseLauncherRpcResponse(
        current.boundary.handle(
          request(signedTicket(current), "stale-quota-receipt"),
          agentPeer,
        ),
      ),
    ).toMatchObject({
      error: { code: "unsupported_host_capability" },
      ok: false,
    });
    expect(manager.starts).toHaveLength(0);
  });
});
