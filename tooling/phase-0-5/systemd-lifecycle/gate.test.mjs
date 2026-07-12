import { describe, expect, it } from "vitest";

import {
  classifyUnitObservation,
  decideSystemdLifecycle,
  recoverUnitFromWal,
} from "./gate.mjs";

describe("Phase 0.5 deterministic systemd lifecycle gate", () => {
  it("fails closed when the isolated test process is not hosted by systemd PID 1", () => {
    const decision = decideSystemdLifecycle({
      cgroupV2: true,
      disposableHost: false,
      pid1: "container-init",
      platform: "linux",
      systemctl: true,
      systemdRun: true,
    });

    expect(decision.status).toBe("unsupported");
    expect(decision.reasonCode).toBe("systemd_host_capability_unavailable");
    expect(decision.productionGate).toBe("closed");
  });

  it("still requires disposable-host crash evidence when prerequisites exist", () => {
    const decision = decideSystemdLifecycle({
      cgroupV2: true,
      disposableHost: false,
      pid1: "systemd",
      platform: "linux",
      systemctl: true,
      systemdRun: true,
    });

    expect(decision).toMatchObject({
      reasonCode: "disposable_host_attestation_missing",
      status: "unsupported",
    });
    expect(decision.requiredHostEvidence).toHaveLength(4);
  });

  it.each([
    [{ active: false, descendantCount: 0, present: true }, "canceled"],
    [{ oomKilled: true, present: true }, "memory_limit"],
    [{ present: true, tasksMaxReached: true }, "pid_limit"],
    [{ present: false }, "unknown"],
  ])("classifies a synthetic systemd observation", (observation, status) => {
    expect(classifyUnitObservation(observation)).toEqual({ status });
  });

  it("rejects a restarted unit whose InvocationID does not match the node WAL", () => {
    const wal = {
      controlGroup: "/wf/synthetic",
      invocationId: "invocation-1",
      unitName: "wf-feasibility-1.service",
    };

    expect(
      recoverUnitFromWal(wal, {
        ...wal,
        active: true,
        invocationId: "invocation-2",
        present: true,
      }),
    ).toEqual({ status: "unknown" });
  });

  it("rejects incomplete WAL identity", () => {
    expect(recoverUnitFromWal({}, { active: true, present: true })).toEqual({
      status: "unknown",
    });
  });
});
