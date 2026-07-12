import { describe, expect, it } from "vitest";

import {
  createNamespaceOwnershipService,
  type NamespaceOwnership,
  type NamespaceOwnershipStore,
} from "@workload-funnel/workload-control/namespace-ownership";
import type {
  OperationGate,
  OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";

import {
  createCrashResumableOwnershipTransferManager,
  type CrashResumableOwnershipTransferStore,
  type OwnershipTransferCoordinator,
  type OwnershipTransferEnvironment,
} from "../index.js";

function ownershipStore(): NamespaceOwnershipStore {
  const rows = new Map<string, NamespaceOwnership>();
  return {
    create(initial) {
      rows.set(initial.namespaceId, initial);
      return initial;
    },
    get: (namespaceId) => rows.get(namespaceId),
    compareAndSet(namespaceId, expectedVersion, next) {
      if (rows.get(namespaceId)?.version !== expectedVersion) {
        throw new Error("version_conflict");
      }
      rows.set(namespaceId, next);
      return next;
    },
  };
}

function coordinatorStore(): CrashResumableOwnershipTransferStore {
  const rows = new Map<string, OwnershipTransferCoordinator>();
  return {
    create(coordinator) {
      rows.set(coordinator.operationId, coordinator);
      return coordinator;
    },
    discoverIncomplete: () =>
      [...rows.values()].filter(
        (item) => !["gates_reopened", "aborted"].includes(item.step),
      ),
    get: (operationId) => rows.get(operationId),
    save(expectedVersion, coordinator) {
      if (rows.get(coordinator.operationId)?.version !== expectedVersion) {
        throw new Error("version_conflict");
      }
      rows.set(coordinator.operationId, coordinator);
      return coordinator;
    },
  };
}

describe("Phase 2 ownership transfer manager integration", () => {
  it("closes effects, advances epoch, installs all authorities, completes, then reopens", () => {
    const ownership = createNamespaceOwnershipService(ownershipStore());
    ownership.initialize("namespace-1", "writer-a", "release-a");
    let gates: OperationGateSet = Object.freeze({
      namespaceId: "namespace-1",
      open: new Set<OperationGate>([
        "acceptance",
        "admission_reservation",
        "dispatch_submit",
        "process_start",
        "automatic_retry",
        "result_finalize",
        "result_archive",
        "result_delete",
      ]),
      revision: 1,
    });
    const environment: OwnershipTransferEnvironment = {
      disableOldCredentials: () => "credentials-disabled",
      drainOldEffects: () => "effects-drained",
      fenceOldAuthorities: () => "old-authorities-fenced",
      getGateSet: () => gates,
      installAuthority: (_coordinator, authorityId, targetEpoch) =>
        Object.freeze({
          authorityId,
          registrySequence: targetEpoch,
          targetEpoch,
          tupleFingerprint: `tuple:${authorityId}:${String(targetEpoch)}`,
        }),
      reconcileAtNewEpoch: () => "reconciled-new-epoch",
      reopenApprovedGates: (_coordinator, current) =>
        Object.freeze({
          ...current,
          open: new Set<OperationGate>([
            "acceptance",
            "admission_reservation",
            "dispatch_submit",
            "process_start",
            "automatic_retry",
            "result_finalize",
            "result_archive",
            "result_delete",
          ]),
          revision: current.revision + 1,
        }),
      saveGateSet: (next) => {
        gates = next;
      },
    };
    const manager = createCrashResumableOwnershipTransferManager(
      ownership,
      coordinatorStore(),
      environment,
    );
    let operation = manager.begin({
      authorityIds: ["gateway-1", "launcher-1"],
      namespaceId: "namespace-1",
      operationId: "transfer-1",
      targetWriterId: "writer-b",
      targetWriterRelease: "release-b",
    });
    while (operation.step !== "gates_reopened") {
      operation = manager.resume(operation.operationId);
      const recovered = manager.discoverIncomplete(undefined, 10);
      if (operation.step !== "gates_reopened")
        expect(recovered).toContain(operation);
    }
    expect(ownership.get("namespace-1")).toMatchObject({
      transfer: { state: "completed" },
      writerEpoch: 2,
      writerId: "writer-b",
    });
    expect(gates.revision).toBe(3);
    expect(gates.open.has("process_start")).toBe(true);
  });
});
