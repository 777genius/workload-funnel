import { describe, expect, it } from "vitest";

import {
  AdmissionCoordinator,
  HardResourceOvercommitError,
  SerializedCapacityReservationLedger,
  StaleCapacityDecisionError,
} from "@workload-funnel/workload-control/allocation-leasing";
import {
  deriveAdmissionCapacity,
  evaluateSafetyBounds,
} from "@workload-funnel/workload-control/capacity-management";
import { registerNode } from "@workload-funnel/workload-control/node-lifecycle";

import {
  SerializedFairnessLedger,
  StaleFairnessDecisionError,
  type AdmissionPolicy,
  type QueuedWorkload,
} from "../index.js";

const openSafety = evaluateSafetyBounds({
  backlogBytes: 0,
  backlogCount: 0,
  diskAvailableBytes: 1000,
  hardBacklogBytes: 100,
  hardBacklogCount: 100,
  hardRecoveryDebt: 100,
  minimumDiskReserveBytes: 10,
  recoveryDebt: 0,
});

const policy: AdmissionPolicy = Object.freeze({
  agingIntervalMs: 10,
  deadlineBoostWindowMs: 20,
  maxAgingBoost: 20,
  maxBypassCount: 3,
  maxQueueAgeMs: 100,
  revision: 7,
  tenants: Object.freeze({
    tenant: Object.freeze({
      classes: Object.freeze({
        build: Object.freeze({
          maxConcurrent: 10,
          resourceQuota: Object.freeze({
            cpuMillis: 10_000,
            memoryMiB: 10_000,
          }),
          weight: 1,
        }),
      }),
      maxConcurrent: 10,
      resourceQuota: Object.freeze({ cpuMillis: 10_000, memoryMiB: 10_000 }),
      tenantId: "tenant",
      weight: 1,
    }),
  }),
});

function workload(attemptId: string): QueuedWorkload {
  return Object.freeze({
    attemptId,
    bypassCount: 0,
    compatiblePoolIds: Object.freeze(["pool"]),
    enqueuedAt: 0,
    lane: "producer",
    priority: 10,
    requiredCapabilities: Object.freeze(["synthetic"]),
    resources: Object.freeze({ cpuMillis: 1000, memoryMiB: 1000 }),
    tenantId: "tenant",
    workloadClass: "build",
  });
}

function source() {
  const node = registerNode({
    bootEpoch: "boot",
    capabilities: ["synthetic"],
    nodeId: "node",
    observation: {
      bootEpoch: "boot",
      capacity: { cpuMillis: 4000, memoryMiB: 4000 },
      observedAt: 1,
      pressure: {
        cpuPsiSome: 0,
        ioPsiSome: 0,
        memoryPsiSome: 0,
        sensorState: "healthy",
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
  const capacity = deriveAdmissionCapacity(node, 1, {
    maxObservationAgeMs: 100,
    recoveryReserveRatio: 0.1,
    requiredDimensions: ["cpuMillis", "memoryMiB"],
    softPressureFactor: 0.5,
  });
  return {
    capabilities: node.capabilities,
    capabilityRevision: node.capabilityRevision,
    capacity,
    fairnessDimensions: ["cpuMillis", "memoryMiB"],
    ledger: new SerializedCapacityReservationLedger({
      capacity: capacity.effective,
      namespaceId: "namespace",
      nodeId: node.nodeId,
      nodeObservationRevision: node.nodeObservationRevision,
      poolId: node.poolId,
    }),
  };
}

describe("phase 3 reservation concurrency and revision validation", () => {
  it("serializes multidimensional counters without hard-resource overcommit", () => {
    const ledger = new SerializedCapacityReservationLedger({
      capacity: { cpuMillis: 8000, gpu: 2, memoryMiB: 16_000, pids: 64 },
      namespaceId: "n",
      nodeId: "node",
      nodeObservationRevision: 4,
      poolId: "pool",
    });
    const proposals = Array.from({ length: 40 }, (_, index) => ({
      allocationId: `allocation-${String(index)}`,
      attemptId: `attempt-${String(index)}`,
      expectedNodeObservationRevision: 4,
      expectedReservationLedgerRevision: 0,
      resources: { cpuMillis: 1000, gpu: 1, memoryMiB: 1000, pids: 4 },
      tenantId: "tenant",
      workloadClass: "build",
    }));

    const results = proposals.map((proposal) => {
      try {
        ledger.reserve(proposal);
        return "reserved";
      } catch (error) {
        expect(error).toBeInstanceOf(StaleCapacityDecisionError);
        return "stale";
      }
    });
    expect(results.filter((value) => value === "reserved")).toHaveLength(1);

    for (;;) {
      const snapshot = ledger.snapshot();
      const index = snapshot.allocationCount;
      try {
        ledger.reserve({
          allocationId: `retry-allocation-${String(index)}`,
          attemptId: `retry-attempt-${String(index)}`,
          expectedNodeObservationRevision: snapshot.nodeObservationRevision,
          expectedReservationLedgerRevision: snapshot.reservationLedgerRevision,
          resources: { cpuMillis: 1000, gpu: 1, memoryMiB: 1000, pids: 4 },
          tenantId: "tenant",
          workloadClass: "build",
        });
      } catch (error) {
        expect(error).toBeInstanceOf(HardResourceOvercommitError);
        break;
      }
    }
    expect(ledger.snapshot()).toMatchObject({
      allocationCount: 2,
      reserved: { cpuMillis: 2000, gpu: 2, memoryMiB: 2000, pids: 8 },
    });
    const releaseRevision = ledger.snapshot().reservationLedgerRevision;
    const released = ledger.release("allocation-0", releaseRevision);
    const duplicate = ledger.release("allocation-0", releaseRevision);
    expect(duplicate.reservationLedgerRevision).toBe(
      released.reservationLedgerRevision,
    );
    expect(duplicate.reserved).toMatchObject({ gpu: 1 });
  });

  it("rejects plans after fairness, capacity, capability, or policy revisions change", () => {
    const firstSource = source();
    const fairness = new SerializedFairnessLedger();
    const coordinator = new AdmissionCoordinator(fairness, [firstSource]);
    const firstPlan = coordinator.plan({
      now: 1,
      policy,
      queue: [workload("a")],
      safety: openSafety,
    }).plan;
    if (firstPlan === undefined) throw new Error("expected_plan");

    fairness.reserve(workload("other"), policy, 0, "pool");
    expect(() => coordinator.commit(firstPlan, "allocation-a", policy)).toThrow(
      StaleFairnessDecisionError,
    );

    const secondSource = source();
    const second = new AdmissionCoordinator(new SerializedFairnessLedger(), [
      secondSource,
    ]);
    const capacityPlan = second.plan({
      now: 1,
      policy,
      queue: [workload("b")],
      safety: openSafety,
    }).plan;
    if (capacityPlan === undefined) throw new Error("expected_plan");
    secondSource.ledger.replaceCapacity(1, 2, {
      cpuMillis: 4000,
      memoryMiB: 4000,
    });
    expect(() => second.commit(capacityPlan, "allocation-b", policy)).toThrow(
      StaleCapacityDecisionError,
    );

    const thirdSource = source();
    const third = new AdmissionCoordinator(new SerializedFairnessLedger(), [
      thirdSource,
    ]);
    const capabilityPlan = third.plan({
      now: 1,
      policy,
      queue: [workload("c")],
      safety: openSafety,
    }).plan;
    if (capabilityPlan === undefined) throw new Error("expected_plan");
    thirdSource.capabilityRevision += 1;
    expect(() => third.commit(capabilityPlan, "allocation-c", policy)).toThrow(
      "stale_capability_revision",
    );

    const fourthSource = source();
    const fourth = new AdmissionCoordinator(new SerializedFairnessLedger(), [
      fourthSource,
    ]);
    const policyPlan = fourth.plan({
      now: 1,
      policy,
      queue: [workload("d")],
      safety: openSafety,
    }).plan;
    if (policyPlan === undefined) throw new Error("expected_plan");
    expect(() =>
      fourth.commit(policyPlan, "allocation-d", { ...policy, revision: 8 }),
    ).toThrow("stale_admission_policy_revision");
    expect(() =>
      fourth.commit(policyPlan, "allocation-d", policy, {
        reasons: ["hard_disk_reserve"],
        status: "closed",
      }),
    ).toThrow("hard_safety_bound");
  });
});
