import { createAllocationLeasingTransactionParticipant } from "@workload-funnel/workload-control/allocation-leasing";
import { createAuditHistoryTransactionParticipant } from "@workload-funnel/workload-control/audit-history";
import { createCapacityManagementTransactionParticipant } from "@workload-funnel/workload-control/capacity-management";
import { createControlEventDeliveryTransactionParticipant } from "@workload-funnel/workload-control/control-event-delivery";
import { createResultManagementTransactionParticipant } from "@workload-funnel/workload-control/result-management";
import { createTenantAdmissionTransactionParticipant } from "@workload-funnel/workload-control/tenant-admission";
import { createWorkloadLifecycleTransactionParticipant } from "@workload-funnel/workload-control/workload-lifecycle";
import { createPostgresCanonicalTransaction } from "@workload-funnel/store-postgres/canonical-transaction";
import { createSqliteCanonicalTransaction } from "@workload-funnel/store-sqlite/canonical-transaction";
import { describe, expect, it } from "vitest";

import {
  canonicalBundleIds,
  canonicalBundleMatrix,
  createProvider,
  InvalidParticipantSetError,
  type CanonicalParticipantRegistry,
  type CanonicalTransaction,
  type CanonicalTransactionTrace,
} from "../index.js";

function registry(): CanonicalParticipantRegistry {
  return Object.freeze({
    "allocation-leasing": createAllocationLeasingTransactionParticipant(),
    "audit-history": createAuditHistoryTransactionParticipant(),
    "capacity-management": createCapacityManagementTransactionParticipant(),
    "control-event-delivery":
      createControlEventDeliveryTransactionParticipant(),
    "result-management": createResultManagementTransactionParticipant(),
    "tenant-admission": createTenantAdmissionTransactionParticipant(),
    "workload-lifecycle": createWorkloadLifecycleTransactionParticipant(),
  });
}

function transaction(): CanonicalTransaction {
  return {
    execute(request, work) {
      return Object.freeze({
        trace: Object.freeze({
          backend: "postgres" as const,
          bundleId: request.bundleId,
          events: Object.freeze(["begin", "commit"]),
          operationId: request.operationId,
        }),
        value: work(),
      });
    },
  };
}

describe("canonical transaction coordinator", () => {
  it("freezes exactly seven participants and all ten normative bundle modes", () => {
    const coordinator = createProvider({
      canonicalTransaction: transaction(),
      participants: registry(),
    });

    expect(coordinator.participantIds).toHaveLength(7);
    expect(Object.isFrozen(coordinator)).toBe(true);
    expect(Object.isFrozen(coordinator.participantIds)).toBe(true);
    expect(Object.keys(canonicalBundleMatrix)).toEqual(canonicalBundleIds);
    expect(canonicalBundleMatrix["release-allocation-v1"].ranks).toEqual([
      20, 30, 40, 50, 60, 110, 120, 130, 140, 150, 160,
    ]);
    expect(
      canonicalBundleMatrix["finalize-result-v1"].modes["result-management"],
    ).toBe("finalize_manifest");
    expect(
      canonicalBundleMatrix["tombstone-result-v1"].modes["result-management"],
    ).toBe("tombstone_manifest");
  });

  it("returns immutable receipts with exact active participants and ranks", () => {
    const coordinator = createProvider({
      canonicalTransaction: transaction(),
      participants: registry(),
    });

    expect(
      coordinator.execute("finalize-result-v1", "result-op", () => "done"),
    ).toBe("done");
    expect(coordinator.receipt("result-op")).toMatchObject({
      activeParticipants: [
        "control-event-delivery",
        "capacity-management",
        "result-management",
        "audit-history",
      ],
      bundleId: "finalize-result-v1",
      ranks: [90, 100, 110, 120, 130, 140, 150],
    });
  });

  it("rejects missing, aliased, mode-incompatible, and wrong-finalizer registries", () => {
    const valid = registry();
    const missing = Object.fromEntries(
      Object.entries(valid).filter(([id]) => id !== "audit-history"),
    );
    expect(() =>
      createProvider({
        canonicalTransaction: transaction(),
        participants: missing as unknown as CanonicalParticipantRegistry,
      }),
    ).toThrow(InvalidParticipantSetError);

    expect(() =>
      createProvider({
        canonicalTransaction: transaction(),
        participants: {
          ...valid,
          "result-management": Object.freeze({
            finalizesRank160: false,
            id: "result-management",
            ownerStoreCount: 4,
            supportedModes: Object.freeze(["finalize_manifest"] as const),
          }),
        },
      }),
    ).toThrow("exact canonical mode set");

    expect(() =>
      createProvider({
        canonicalTransaction: transaction(),
        participants: {
          ...valid,
          "allocation-leasing": Object.freeze({
            ...valid["allocation-leasing"],
            finalizesRank160: false,
          }),
        },
      }),
    ).toThrow("rank-160 finalizer");
  });

  it.each(["postgres", "sqlite"] as const)(
    "executes all ten exact bundle traces through the %s backend",
    (backend) => {
      const traces: CanonicalTransactionTrace[] = [];
      const sink = {
        append: (trace: CanonicalTransactionTrace) => traces.push(trace),
      };
      const canonicalTransaction =
        backend === "postgres"
          ? createPostgresCanonicalTransaction(sink)
          : createSqliteCanonicalTransaction(sink);
      const coordinator = createProvider({
        canonicalTransaction,
        participants: registry(),
      });

      for (const bundleId of canonicalBundleIds) {
        const operationId = `${backend}:${bundleId}`;
        coordinator.execute(bundleId, operationId, () => undefined);
        const receipt = coordinator.receipt(operationId);
        expect(receipt?.ranks).toEqual(canonicalBundleMatrix[bundleId].ranks);
        expect(receipt?.activeParticipants).toEqual(
          expect.arrayContaining(
            Object.keys(canonicalBundleMatrix[bundleId].modes),
          ),
        );
        for (const rank of canonicalBundleMatrix[bundleId].ranks) {
          expect(receipt?.trace.events).toContain(
            backend === "postgres"
              ? `physicalLock:${String(rank)}:SELECT FOR UPDATE`
              : `rankedKeyLoad:${String(rank)}`,
          );
        }
      }
      expect(traces).toHaveLength(10);
      expect(
        coordinator.receipt(`${backend}:finalize-result-v1`)
          ?.activeParticipants,
      ).toContain("result-management");
      expect(
        coordinator.receipt(`${backend}:tombstone-result-v1`)
          ?.activeParticipants,
      ).toContain("result-management");
    },
  );
});
