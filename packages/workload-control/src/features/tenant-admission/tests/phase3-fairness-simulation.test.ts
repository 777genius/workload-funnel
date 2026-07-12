import { describe, expect, it } from "vitest";

import {
  AdmissionCoordinator,
  SerializedCapacityReservationLedger,
  type CapacitySource,
} from "@workload-funnel/workload-control/allocation-leasing";
import {
  deriveAdmissionCapacity,
  evaluateSafetyBounds,
} from "@workload-funnel/workload-control/capacity-management";
import { registerNode } from "@workload-funnel/workload-control/node-lifecycle";

import {
  SerializedFairnessLedger,
  recordQueueBypasses,
  type AdmissionPolicy,
  type QueuedWorkload,
} from "../index.js";

const openSafety = evaluateSafetyBounds({
  backlogBytes: 0,
  backlogCount: 0,
  diskAvailableBytes: 1_000_000,
  hardBacklogBytes: 1_000_000,
  hardBacklogCount: 10_000,
  hardRecoveryDebt: 1000,
  minimumDiskReserveBytes: 100,
  recoveryDebt: 0,
});

function tenantPolicy(
  tenantId: string,
  weight: number,
  maxConcurrent: number,
): AdmissionPolicy["tenants"][string] {
  return Object.freeze({
    classes: Object.freeze({
      batch: Object.freeze({
        maxConcurrent,
        resourceQuota: Object.freeze({
          cpu: maxConcurrent,
          memory: maxConcurrent,
        }),
        weight: 1,
      }),
      interactive: Object.freeze({
        maxConcurrent,
        resourceQuota: Object.freeze({
          cpu: maxConcurrent,
          memory: maxConcurrent,
        }),
        weight: 2,
      }),
    }),
    maxConcurrent,
    resourceQuota: Object.freeze({ cpu: maxConcurrent, memory: maxConcurrent }),
    tenantId,
    weight,
  });
}

function policy(overrides: Partial<AdmissionPolicy> = {}): AdmissionPolicy {
  return Object.freeze({
    agingIntervalMs: 10,
    deadlineBoostWindowMs: 20,
    maxAgingBoost: 50,
    maxBypassCount: 3,
    maxQueueAgeMs: 100,
    revision: 1,
    tenants: Object.freeze({
      a: tenantPolicy("a", 1, 4),
      b: tenantPolicy("b", 2, 8),
    }),
    ...overrides,
  });
}

function work(
  input: Readonly<{
    attemptId: string;
    tenantId?: string;
    workloadClass?: string;
    cpu?: number;
    memory?: number;
    priority?: number;
    enqueuedAt?: number;
    bypassCount?: number;
    lane?: "producer" | "recovery";
    deadlineAt?: number;
  }>,
): QueuedWorkload {
  const deadline =
    input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt };
  return Object.freeze({
    attemptId: input.attemptId,
    bypassCount: input.bypassCount ?? 0,
    compatiblePoolIds: Object.freeze(["pool"]),
    enqueuedAt: input.enqueuedAt ?? 0,
    lane: input.lane ?? "producer",
    priority: input.priority ?? 0,
    requiredCapabilities: Object.freeze(["synthetic"]),
    resources: Object.freeze({
      cpu: input.cpu ?? 1,
      memory: input.memory ?? 1,
    }),
    tenantId: input.tenantId ?? "a",
    workloadClass: input.workloadClass ?? "batch",
    ...deadline,
  });
}

function capacitySource(
  nodeId: string,
  cpu: number,
  recoveryReserveRatio = 0,
): CapacitySource {
  const node = registerNode({
    bootEpoch: `boot-${nodeId}`,
    capabilities: ["synthetic"],
    nodeId,
    observation: {
      bootEpoch: `boot-${nodeId}`,
      capacity: { cpu, memory: cpu },
      observedAt: 0,
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
  const capacity = deriveAdmissionCapacity(node, 0, {
    maxObservationAgeMs: 100,
    recoveryReserveRatio,
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

describe("deterministic phase 3 fairness simulations", () => {
  it("implements weighted DRF while enforcing tenant and class quotas", () => {
    const source = capacitySource("node", 12);
    const fairness = new SerializedFairnessLedger();
    const coordinator = new AdmissionCoordinator(fairness, [source]);
    const queue = [
      ...Array.from({ length: 8 }, (_, index) =>
        work({ attemptId: `a-${String(index)}`, tenantId: "a" }),
      ),
      ...Array.from({ length: 12 }, (_, index) =>
        work({ attemptId: `b-${String(index)}`, tenantId: "b" }),
      ),
    ];
    const admitted: string[] = [];

    for (;;) {
      const selection = coordinator.plan({
        now: 0,
        policy: policy(),
        queue,
        safety: openSafety,
      });
      if (selection.plan === undefined) break;
      const plan = selection.plan;
      coordinator.commit(
        plan,
        `allocation-${plan.workload.attemptId}`,
        policy(),
      );
      admitted.push(plan.workload.tenantId);
      queue.splice(
        queue.findIndex((item) => item.attemptId === plan.workload.attemptId),
        1,
      );
    }

    expect(admitted.filter((tenant) => tenant === "a")).toHaveLength(4);
    expect(admitted.filter((tenant) => tenant === "b")).toHaveLength(8);
    expect(fairness.snapshot().poolTenantResources["pool/a"]).toMatchObject({
      cpu: 4,
    });
    for (let index = 2; index < admitted.length; index += 1) {
      const prefix = admitted.slice(0, index + 1);
      const a = prefix.filter((tenant) => tenant === "a").length;
      const b = prefix.filter((tenant) => tenant === "b").length;
      expect(Math.abs(b - 2 * a)).toBeLessThanOrEqual(2);
    }
    expect(
      coordinator
        .plan({ now: 0, policy: policy(), queue, safety: openSafety })
        .explanations.some((value) => value.reason.includes("quota")),
    ).toBe(true);
  });

  it("applies workload-class quota independently from tenant quota", () => {
    const source = capacitySource("node", 4);
    const fairness = new SerializedFairnessLedger();
    const baseTenant = tenantPolicy("a", 1, 4);
    const currentPolicy = policy({
      tenants: {
        a: {
          ...baseTenant,
          classes: {
            ...baseTenant.classes,
            batch: {
              maxConcurrent: 2,
              resourceQuota: { cpu: 4, memory: 4 },
              weight: 1,
            },
          },
        },
      },
    });
    const coordinator = new AdmissionCoordinator(fairness, [source]);
    const queue = [work({ attemptId: "one" }), work({ attemptId: "two" })];
    for (const item of queue) {
      const plan = coordinator.plan({
        now: 0,
        policy: currentPolicy,
        queue: [item],
        safety: openSafety,
      }).plan;
      if (plan === undefined) throw new Error("expected_plan");
      coordinator.commit(plan, `allocation-${item.attemptId}`, currentPolicy);
    }
    const third = coordinator.plan({
      now: 0,
      policy: currentPolicy,
      queue: [work({ attemptId: "three" })],
      safety: openSafety,
    });
    expect(third.plan).toBeUndefined();
    expect(third.explanations[0]?.reason).toBe("class_concurrency_quota");
  });

  it("bounds large-workload starvation with bypass reservation", () => {
    const source = capacitySource("node", 8);
    const fairness = new SerializedFairnessLedger();
    const currentPolicy = policy({ tenants: { a: tenantPolicy("a", 1, 20) } });
    const coordinator = new AdmissionCoordinator(fairness, [source]);
    let queue: readonly QueuedWorkload[] = [
      work({ attemptId: "large", cpu: 8, memory: 8, priority: 0 }),
      work({ attemptId: "small-0", priority: 100 }),
    ];
    let largeAdmissionRound: number | undefined;

    for (let round = 0; round < 6; round += 1) {
      const selection = coordinator.plan({
        now: round,
        policy: currentPolicy,
        queue,
        safety: openSafety,
      });
      const plan = selection.plan;
      if (plan === undefined) throw new Error("expected_plan");
      const allocationId = `allocation-${String(round)}`;
      coordinator.commit(plan, allocationId, currentPolicy);
      if (plan.workload.attemptId === "large") {
        largeAdmissionRound = round;
        break;
      }
      source.ledger.release(
        allocationId,
        source.ledger.snapshot().reservationLedgerRevision,
      );
      fairness.release(
        plan.workload.attemptId,
        fairness.snapshot().fairnessRevision,
      );
      queue = [
        ...recordQueueBypasses(queue, plan.workload.attemptId),
        work({ attemptId: `small-${String(round + 1)}`, priority: 100 }),
      ];
    }

    expect(largeAdmissionRound).toBeLessThanOrEqual(
      currentPolicy.maxBypassCount,
    );
  });

  it("bounds priority starvation through capped queue aging", () => {
    const source = capacitySource("node", 1);
    const currentPolicy = policy({
      agingIntervalMs: 1,
      maxBypassCount: 100,
      maxQueueAgeMs: 1000,
      tenants: { a: tenantPolicy("a", 1, 4) },
    });
    const coordinator = new AdmissionCoordinator(
      new SerializedFairnessLedger(),
      [source],
    );
    const oldLowPriority = work({
      attemptId: "old-low",
      enqueuedAt: 0,
      priority: 0,
    });
    const newHighPriority = work({
      attemptId: "new-high",
      enqueuedAt: 100,
      priority: 40,
    });

    const selected = coordinator.plan({
      now: 100,
      policy: currentPolicy,
      queue: [newHighPriority, oldLowPriority],
      safety: openSafety,
    }).plan;
    expect(selected?.workload.attemptId).toBe("old-low");
  });

  it("keeps a recovery lane available without a fixed idle-worker reservation", () => {
    const source = capacitySource("node", 10, 0.2);
    const currentPolicy = policy({ tenants: { a: tenantPolicy("a", 1, 20) } });
    const coordinator = new AdmissionCoordinator(
      new SerializedFairnessLedger(),
      [source],
    );
    const recovery = work({ attemptId: "recovery", cpu: 2, lane: "recovery" });
    const producer = work({ attemptId: "producer", cpu: 10, priority: 100 });
    const selected = coordinator.plan({
      now: 0,
      policy: currentPolicy,
      queue: [producer, recovery],
      safety: openSafety,
    }).plan;

    expect(selected?.workload.attemptId).toBe("recovery");
    const borrowing = coordinator.plan({
      now: 0,
      policy: currentPolicy,
      queue: [producer],
      safety: openSafety,
    }).plan;
    expect(borrowing?.workload.attemptId).toBe("producer");
  });
});
