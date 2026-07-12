import { describe, expect, it } from "vitest";

import {
  InvalidNodeObservationError,
  StaleNodeRevisionError,
  recordNodeObservation,
  registerNode,
  replaceNodeCapabilities,
  transitionNodeScheduling,
  type NodeObservation,
  type PressureHysteresisPolicy,
} from "../index.js";
import {
  deriveAdmissionCapacity,
  evaluateSafetyBounds,
} from "@workload-funnel/workload-control/capacity-management";

const hysteresis: PressureHysteresisPolicy = Object.freeze({
  criticalThreshold: 0.8,
  healthyObservationsToRecover: 2,
  highObservationsToPause: 2,
  highThreshold: 0.5,
  softThreshold: 0.2,
});

function observation(
  sourceSequence: number,
  observedAt: number,
  pressure: number,
  sensorState: "healthy" | "failed" = "healthy",
): NodeObservation {
  return Object.freeze({
    bootEpoch: "boot-1",
    capacity: Object.freeze({
      cpuMillis: 8000,
      ephemeralDiskBytes: 1_000_000,
      memoryMiB: 16_384,
      pids: 512,
    }),
    observedAt,
    pressure: Object.freeze({
      cpuPsiSome: pressure,
      ioPsiSome: pressure,
      memoryPsiSome: pressure,
      sensorState,
    }),
    sourceSequence,
  });
}

function registeredNode() {
  return registerNode({
    bootEpoch: "boot-1",
    capabilities: ["local_dispatch", "artifact_verification"],
    nodeId: "node-a",
    observation: observation(1, 100, 0.05),
    poolId: "general",
    pressurePolicy: hysteresis,
  });
}

describe("phase 3 node-owned observation snapshots", () => {
  it("advances capability and observation revisions only through Node mutations", () => {
    const first = registeredNode();
    const capabilities = replaceNodeCapabilities(first, first.version, [
      "local_dispatch",
      "gpu",
    ]);
    const observed = recordNodeObservation(
      capabilities,
      capabilities.version,
      observation(2, 200, 0.25),
      hysteresis,
    );

    expect(observed).toMatchObject({
      capabilityRevision: 2,
      nodeObservationRevision: 2,
      pressureMode: "derated",
      version: 3,
    });
    expect(Object.isFrozen(observed.reportedCapacity)).toBe(true);
    expect(() => replaceNodeCapabilities(observed, 1, [])).toThrow(
      StaleNodeRevisionError,
    );
    expect(() =>
      recordNodeObservation(
        observed,
        observed.version,
        observation(2, 300, 0.1),
        hysteresis,
      ),
    ).toThrow(InvalidNodeObservationError);
  });

  it("uses sustained pressure and multiple healthy observations for recovery", () => {
    const first = registeredNode();
    const highOnce = recordNodeObservation(
      first,
      first.version,
      observation(2, 200, 0.6),
      hysteresis,
    );
    const paused = recordNodeObservation(
      highOnce,
      highOnce.version,
      observation(3, 300, 0.6),
      hysteresis,
    );
    const recovering = recordNodeObservation(
      paused,
      paused.version,
      observation(4, 400, 0.05),
      hysteresis,
    );
    const recovered = recordNodeObservation(
      recovering,
      recovering.version,
      observation(5, 500, 0.05),
      hysteresis,
    );

    expect(highOnce.pressureMode).toBe("derated");
    expect(paused.pressureMode).toBe("paused");
    expect(recovering.pressureMode).toBe("paused");
    expect(recovered.pressureMode).toBe("healthy");
  });

  it("derives read-only effective capacity and closes stale or failed evidence", () => {
    const first = registeredNode();
    const policy = {
      maxObservationAgeMs: 50,
      recoveryReserveRatio: 0.1,
      requiredDimensions: ["cpuMillis", "memoryMiB", "pids"],
      softPressureFactor: 0.5,
    } as const;
    const beforeVersion = first.version;

    expect(deriveAdmissionCapacity(first, 151, policy)).toMatchObject({
      effective: { cpuMillis: 0, memoryMiB: 0, pids: 0 },
      status: "closed_stale",
    });
    expect(first.version).toBe(beforeVersion);

    const failed = recordNodeObservation(
      first,
      first.version,
      observation(2, 200, 0, "failed"),
      hysteresis,
    );
    expect(deriveAdmissionCapacity(failed, 200, policy).status).toBe(
      "closed_sensor_failed",
    );

    const cordoned = transitionNodeScheduling(first, first.version, "cordoned");
    expect(deriveAdmissionCapacity(cordoned, 100, policy).status).toBe(
      "closed_node_state",
    );
  });

  it("closes acceptance at hard backlog, disk, or debt bounds", () => {
    const baseline = {
      backlogBytes: 10,
      backlogCount: 1,
      diskAvailableBytes: 1000,
      hardBacklogBytes: 100,
      hardBacklogCount: 10,
      hardRecoveryDebt: 10,
      minimumDiskReserveBytes: 100,
      recoveryDebt: 1,
    };
    expect(evaluateSafetyBounds(baseline).status).toBe("open");
    expect(
      evaluateSafetyBounds({
        ...baseline,
        backlogCount: 10,
        diskAvailableBytes: 100,
        recoveryDebt: 10,
      }),
    ).toEqual({
      reasons: [
        "hard_backlog_count",
        "hard_disk_reserve",
        "hard_recovery_debt",
      ],
      status: "closed",
    });
  });
});
