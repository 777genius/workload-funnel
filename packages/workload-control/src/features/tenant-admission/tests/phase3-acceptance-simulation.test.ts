import { describe, expect, it } from "vitest";

import {
  AdmissionCoordinator,
  SerializedCapacityReservationLedger,
  type CapacitySource,
} from "@workload-funnel/workload-control/allocation-leasing";
import {
  deriveAdmissionCapacity,
  evaluateSafetyBounds,
  type DerivedCapacitySnapshot,
} from "@workload-funnel/workload-control/capacity-management";
import { registerNode } from "@workload-funnel/workload-control/node-lifecycle";

import {
  AdmissionExplanationGapError,
  AdmissionExplanationView,
  SerializedFairnessLedger,
  type AdmissionPolicy,
  type QueuedWorkload,
} from "../index.js";

const safety = evaluateSafetyBounds({
  backlogBytes: 0,
  backlogCount: 0,
  diskAvailableBytes: 1000,
  hardBacklogBytes: 100,
  hardBacklogCount: 100,
  hardRecoveryDebt: 100,
  minimumDiskReserveBytes: 10,
  recoveryDebt: 0,
});

function admissionPolicy(maxConcurrent: number): AdmissionPolicy {
  const quota = Object.freeze({
    cpu: maxConcurrent * 4,
    memory: maxConcurrent * 4,
  });
  return Object.freeze({
    agingIntervalMs: 10,
    deadlineBoostWindowMs: 20,
    maxAgingBoost: 30,
    maxBypassCount: 4,
    maxQueueAgeMs: 100,
    revision: 1,
    tenants: Object.freeze({
      tenant: Object.freeze({
        classes: Object.freeze({
          default: Object.freeze({
            maxConcurrent,
            resourceQuota: quota,
            weight: 1,
          }),
        }),
        maxConcurrent,
        resourceQuota: quota,
        tenantId: "tenant",
        weight: 1,
      }),
    }),
  });
}

function workload(
  attemptId: string,
  cpu = 1,
  priority = 0,
  requiredCapabilities: readonly string[] = ["synthetic"],
): QueuedWorkload {
  return Object.freeze({
    attemptId,
    bypassCount: 0,
    compatiblePoolIds: Object.freeze(["pool"]),
    enqueuedAt: 0,
    lane: "producer",
    priority,
    requiredCapabilities: Object.freeze([...requiredCapabilities]),
    resources: Object.freeze({ cpu, memory: cpu }),
    tenantId: "tenant",
    workloadClass: "default",
  });
}

function createSource(
  nodeId: string,
  capacityAmount: number,
  status: "healthy" | "failed" = "healthy",
): CapacitySource {
  const node = registerNode({
    bootEpoch: `boot-${nodeId}`,
    capabilities: ["synthetic"],
    nodeId,
    observation: {
      bootEpoch: `boot-${nodeId}`,
      capacity: { cpu: capacityAmount, memory: capacityAmount },
      observedAt: 0,
      pressure: {
        cpuPsiSome: 0,
        ioPsiSome: 0,
        memoryPsiSome: 0,
        sensorState: status,
      },
      sourceSequence: 1,
    },
    poolId: "pool",
    pressurePolicy: {
      criticalThreshold: 0.8,
      healthyObservationsToRecover: 2,
      highObservationsToPause: 2,
      highThreshold: 0.5,
      softThreshold: 0.2,
    },
  });
  const capacity: DerivedCapacitySnapshot = deriveAdmissionCapacity(node, 0, {
    maxObservationAgeMs: 100,
    recoveryReserveRatio: 0.1,
    requiredDimensions: ["cpu", "memory"],
    softPressureFactor: 0.5,
  });
  return Object.freeze({
    capabilities: node.capabilities,
    capabilityRevision: node.capabilityRevision,
    capacity,
    fairnessDimensions: ["cpu", "memory"],
    ledger: new SerializedCapacityReservationLedger({
      capacity: capacity.effective,
      namespaceId: "namespace",
      nodeId,
      nodeObservationRevision: node.nodeObservationRevision,
      poolId: "pool",
    }),
  });
}

function simulate(workerCount: number): number {
  const sources = Array.from({ length: workerCount }, (_, index) =>
    createSource(`node-${String(index)}`, 4),
  );
  const currentPolicy = admissionPolicy(workerCount * 4);
  const coordinator = new AdmissionCoordinator(
    new SerializedFairnessLedger(),
    sources,
  );
  const queue = Array.from({ length: workerCount * 6 }, (_, index) =>
    workload(`attempt-${String(index)}`),
  );
  let admitted = 0;
  for (;;) {
    const selection = coordinator.plan({
      now: 0,
      policy: currentPolicy,
      queue,
      safety,
    });
    if (selection.plan === undefined) break;
    coordinator.commit(
      selection.plan,
      `allocation-${selection.plan.workload.attemptId}`,
      currentPolicy,
    );
    queue.splice(
      queue.findIndex(
        (item) => item.attemptId === selection.plan?.workload.attemptId,
      ),
      1,
    );
    admitted += 1;
  }
  for (const source of sources) {
    const snapshot = source.ledger.snapshot();
    expect(snapshot.reserved["cpu"]).toBeLessThanOrEqual(
      snapshot.capacity["cpu"] ?? 0,
    );
    expect(snapshot.reserved["memory"]).toBeLessThanOrEqual(
      snapshot.capacity["memory"] ?? 0,
    );
  }
  return admitted;
}

describe("deterministic phase 3 acceptance simulations", () => {
  it("derives admission from discovered capacity with no fixed worker-count assumption", () => {
    for (const workerCount of [1, 3, 7]) {
      expect(simulate(workerCount)).toBe(workerCount * 4);
    }
  });

  it("rejects permanent envelope and capability mismatches instead of queueing forever", () => {
    const coordinator = new AdmissionCoordinator(
      new SerializedFairnessLedger(),
      [createSource("node", 4)],
    );
    const selection = coordinator.plan({
      now: 0,
      policy: admissionPolicy(10),
      queue: [
        workload("too-large", 5),
        workload("missing-capability", 1, 0, ["gpu"]),
      ],
      safety,
    });

    expect(selection.plan).toBeUndefined();
    expect(selection.explanations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: "too-large",
          outcome: "reject",
          reason: "permanently_unschedulable",
        }),
        expect.objectContaining({
          attemptId: "missing-capability",
          outcome: "reject",
          reason: "missing_capability",
        }),
      ]),
    );
  });

  it("fails admission closed for failed sensors with revisioned explanations", () => {
    const coordinator = new AdmissionCoordinator(
      new SerializedFairnessLedger(),
      [createSource("failed-node", 4, "failed")],
    );
    const selection = coordinator.plan({
      now: 0,
      policy: admissionPolicy(4),
      queue: [workload("attempt")],
      safety,
    });

    expect(selection.plan).toBeUndefined();
    expect(selection.explanations[0]).toMatchObject({
      admissionPolicyRevision: 1,
      attemptId: "attempt",
      details: ["pressure_sensor_failed"],
      fairnessRevision: 0,
      outcome: "defer",
      reason: "pressure_closed",
    });
    const view = new AdmissionExplanationView();
    const explanation = selection.explanations[0];
    if (explanation === undefined) throw new Error("expected_explanation");
    view.applyNext(1, explanation);
    expect(view.latest("attempt")).toBe(explanation);
    expect(() => view.applyNext(3, explanation)).toThrow(
      AdmissionExplanationGapError,
    );
  });

  it("orders by bounded priority and deadline without preempting active work", () => {
    const source = createSource("node", 1);
    const fairness = new SerializedFairnessLedger();
    const currentPolicy = admissionPolicy(3);
    const coordinator = new AdmissionCoordinator(fairness, [source]);
    const low = workload("low", 1, 0);
    const initial = coordinator.plan({
      now: 0,
      policy: currentPolicy,
      queue: [low],
      safety,
    });
    if (initial.plan === undefined) throw new Error("expected_plan");
    coordinator.commit(initial.plan, "allocation-low", currentPolicy);

    const high = workload("high", 1, 100);
    const blocked = coordinator.plan({
      now: 10,
      policy: currentPolicy,
      queue: [high],
      safety,
    });
    expect(blocked.plan).toBeUndefined();
    expect(blocked.explanations[0]?.reason).toBe("capacity_unavailable");
    expect(source.ledger.snapshot()).toMatchObject({
      allocationCount: 1,
      reserved: { cpu: 1, memory: 1 },
    });
    expect(fairness.snapshot().tenantConcurrent["tenant"]).toBe(1);
  });
});
