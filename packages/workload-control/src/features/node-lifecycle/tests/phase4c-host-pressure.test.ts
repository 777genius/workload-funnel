import { describe, expect, it } from "vitest";

import {
  deriveAdmissionCapacity,
  deriveHostSurvivalAdmission,
  laneCapacity,
} from "@workload-funnel/workload-control/capacity-management";
import { createSyntheticHostSurvivalProfile } from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
import {
  evaluateHostPressure,
  fingerprintHostPressurePolicy,
  recordHostSurvivalObservation,
  registerNode,
  type HostPressureDimension,
  type HostPressureHysteresisPolicy,
  type HostPressureObservation,
} from "../index.js";

const dimensions: readonly HostPressureDimension[] = [
  "cpu_psi_full",
  "cpu_psi_some",
  "disk",
  "inodes",
  "io_psi_full",
  "io_psi_some",
  "journal",
  "memory_available",
  "memory_psi_full",
  "memory_psi_some",
  "node_spool",
  "pids",
];

const thresholds = Object.freeze(
  Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      Object.freeze({ critical: 0.9, high: 0.7, soft: 0.4 }),
    ]),
  ) as Record<
    HostPressureDimension,
    { critical: number; high: number; soft: number }
  >,
);

const policy: HostPressureHysteresisPolicy = Object.freeze({
  healthyObservationsToRecover: 3,
  highObservationsToPause: 2,
  maximumObservationAgeMs: 1_000,
  policyId: "single-host-pressure-v1",
  revision: 1,
  softDerateFactor: 0.5,
  thresholds,
});

function observation(
  sequence: number,
  observedAt: number,
  overrides: Partial<HostPressureObservation> = {},
): HostPressureObservation {
  return {
    cpu: { fullAvg10: 0.01, someAvg10: 0.01 },
    diskUsedRatio: 0.1,
    inodeUsedRatio: 0.1,
    io: { fullAvg10: 0.01, someAvg10: 0.01 },
    journalUsedRatio: 0.1,
    memory: { fullAvg10: 0.01, someAvg10: 0.01 },
    memoryAvailableRatio: 0.9,
    nodeSpoolUsedRatio: 0.1,
    observedAt,
    pidUsedRatio: 0.1,
    sensorState: "fresh",
    sourceSequence: sequence,
    ...overrides,
  };
}

function withDimension(
  source: HostPressureObservation,
  dimension: HostPressureDimension,
  value: number,
): HostPressureObservation {
  switch (dimension) {
    case "cpu_psi_full":
      return { ...source, cpu: { ...source.cpu, fullAvg10: value } };
    case "cpu_psi_some":
      return { ...source, cpu: { ...source.cpu, someAvg10: value } };
    case "disk":
      return { ...source, diskUsedRatio: value };
    case "inodes":
      return { ...source, inodeUsedRatio: value };
    case "io_psi_full":
      return { ...source, io: { ...source.io, fullAvg10: value } };
    case "io_psi_some":
      return { ...source, io: { ...source.io, someAvg10: value } };
    case "journal":
      return { ...source, journalUsedRatio: value };
    case "memory_available":
      return { ...source, memoryAvailableRatio: 1 - value };
    case "memory_psi_full":
      return { ...source, memory: { ...source.memory, fullAvg10: value } };
    case "memory_psi_some":
      return { ...source, memory: { ...source.memory, someAvg10: value } };
    case "node_spool":
      return { ...source, nodeSpoolUsedRatio: value };
    case "pids":
      return { ...source, pidUsedRatio: value };
  }
}

function canonicalNode() {
  return registerNode({
    bootEpoch: "boot-1",
    capabilities: ["pressure_fail_closed_admission"],
    nodeId: "node-1",
    observation: {
      bootEpoch: "boot-1",
      capacity: { cpu: 8, memory: 16 },
      observedAt: 50,
      pressure: {
        cpuPsiSome: 0.01,
        ioPsiSome: 0.01,
        memoryPsiSome: 0.01,
        sensorState: "healthy",
      },
      sourceSequence: 1,
    },
    poolId: "pool-1",
    pressurePolicy: {
      criticalThreshold: 0.9,
      healthyObservationsToRecover: 3,
      highObservationsToPause: 2,
      highThreshold: 0.7,
      softThreshold: 0.4,
    },
  });
}

function recordCanonical(
  node: ReturnType<typeof canonicalNode>,
  next: HostPressureObservation,
) {
  return recordHostSurvivalObservation(
    node,
    node.version,
    next,
    createSyntheticHostSurvivalProfile(),
    policy,
    next.observedAt,
  );
}

describe("Phase 4C HostSurvival PSI hysteresis", () => {
  it("binds the versioned HostSurvivalProfile to the exact pressure policy", () => {
    expect(createSyntheticHostSurvivalProfile().pressurePolicyBinding).toEqual({
      digest: fingerprintHostPressurePolicy(policy),
      policyId: policy.policyId,
      revision: policy.revision,
    });
    const profile = createSyntheticHostSurvivalProfile();
    expect(() =>
      recordHostSurvivalObservation(
        canonicalNode(),
        1,
        observation(2, 100),
        {
          ...profile,
          pressurePolicyBinding: {
            ...profile.pressurePolicyBinding,
            digest: "0".repeat(64),
          },
        },
        policy,
        100,
      ),
    ).toThrow("host_pressure_policy_fingerprint_mismatch");
  });

  it.each(dimensions)(
    "closes producer admission for critical %s",
    (dimension) => {
      const node = recordCanonical(
        canonicalNode(),
        withDimension(observation(2, 100), dimension, 0.95),
      );
      const state = node.hostPressureState;
      const decision = deriveHostSurvivalAdmission(node);

      expect(state).toMatchObject({ derateFactor: 0, mode: "critical" });
      expect(state?.reasons).toEqual([`critical:${dimension}`]);
      expect(decision).toMatchObject({
        controlOperations: {
          breakGlassStop: true,
          cancellation: true,
          observation: true,
        },
        producerAdmission: "paused",
        producerFactor: 0,
        recoveryAdmission: "open",
      });
      const capacity = deriveAdmissionCapacity(node, 100, {
        maxObservationAgeMs: 1_000,
        recoveryReserveRatio: 0.1,
        requiredDimensions: ["cpu", "memory"],
        softPressureFactor: 0.5,
      });
      expect(capacity).toMatchObject({
        reasons: [`critical:${dimension}`],
        status: "producer_paused",
      });
      expect(laneCapacity(capacity, "producer", false)).toEqual({
        cpu: 0,
        memory: 0,
      });
      expect(laneCapacity(capacity, "recovery", false)).toEqual({
        cpu: 8,
        memory: 16,
      });
    },
  );

  it("requires sustained high pressure and three healthy samples to recover", () => {
    const first = recordCanonical(
      canonicalNode(),
      withDimension(observation(2, 100), "memory_psi_some", 0.75),
    );
    const paused = recordCanonical(
      first,
      withDimension(observation(3, 200), "memory_psi_some", 0.75),
    );
    const recovering1 = recordCanonical(paused, observation(4, 300));
    const recovering2 = recordCanonical(recovering1, observation(5, 400));
    const recovered = recordCanonical(recovering2, observation(6, 500));

    expect(first.hostPressureState?.mode).toBe("derated");
    expect(paused.hostPressureState?.mode).toBe("paused");
    expect(recovering1.hostPressureState?.mode).toBe("paused");
    expect(recovering2.hostPressureState?.mode).toBe("paused");
    expect(recovered.hostPressureState).toMatchObject({
      derateFactor: 1,
      mode: "healthy",
    });
    expect(deriveHostSurvivalAdmission(recovered)).toMatchObject({
      producerAdmission: "open",
      producerFactor: 1,
    });
    const reopened = deriveAdmissionCapacity(recovered, 500, {
      maxObservationAgeMs: 1_000,
      recoveryReserveRatio: 0.1,
      requiredDimensions: ["cpu", "memory"],
      softPressureFactor: 0.5,
    });
    expect(reopened.status).toBe("open");
    expect(laneCapacity(reopened, "producer", false)).toEqual({
      cpu: 8,
      memory: 16,
    });
  });

  it("fails closed for stale, failed, replayed, or malformed evidence", () => {
    expect(
      evaluateHostPressure(
        undefined,
        observation(1, 100, { sensorState: "failed" }),
        policy,
        100,
      ),
    ).toMatchObject({ mode: "critical", reasons: ["sensor_failed"] });
    expect(
      evaluateHostPressure(undefined, observation(1, 100), policy, 1_101),
    ).toMatchObject({ mode: "critical", reasons: ["sensor_stale"] });
    const current = evaluateHostPressure(
      undefined,
      observation(2, 200),
      policy,
      200,
    );
    expect(() =>
      evaluateHostPressure(current, observation(2, 300), policy, 300),
    ).toThrow("stale_host_pressure_sequence");
    expect(() =>
      evaluateHostPressure(
        undefined,
        observation(1, 100, { diskUsedRatio: Number.NaN }),
        policy,
        100,
      ),
    ).toThrow("invalid_host_pressure:disk");
  });
});
