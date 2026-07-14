import { describe, expect, it } from "vitest";
import type { MutationFence } from "@workload-funnel/kernel";

import { createSyntheticExternalWitness } from "@workload-funnel/control-service/phase1-synthetic-runtime";

import { createPostgresCapacityReservationLedgerStore } from "@workload-funnel/store-postgres/capacity-reservation-ledger-persistence";
import { createPostgresNamespaceOwnershipStore } from "@workload-funnel/store-postgres/namespace-ownership-persistence";
import { createInMemoryPostgresOwnershipTransferCoordinatorStoreTestFake } from "@workload-funnel/store-postgres/ownership-transfer-coordinator-persistence";
import { createSqliteCapacityReservationLedgerStore } from "@workload-funnel/store-sqlite/capacity-reservation-ledger-persistence";
import { createSqliteNamespaceOwnershipStore } from "@workload-funnel/store-sqlite/namespace-ownership-persistence";
import { createInMemorySqliteOwnershipTransferCoordinatorStoreTestFake } from "@workload-funnel/store-sqlite/ownership-transfer-coordinator-persistence";
import type {
  Allocation,
  AllocationReleaseReceipt,
  ReservationRollbackReceipt,
  TerminalReleaseReceipt,
} from "@workload-funnel/workload-control/allocation-leasing";
import type { NamespaceOwnership } from "@workload-funnel/workload-control/namespace-ownership";
import {
  createAcceptanceDurabilityReceipt,
  reconcileAcceptanceWitness,
  type WitnessRecord,
} from "@workload-funnel/workload-control/workload-lifecycle";
import {
  advanceOwnershipTransferCoordinator,
  createOwnershipTransferCoordinator,
  type OwnershipTransferCoordinator,
} from "@workload-funnel/workload-control/ownership-transfer";

function capacityState() {
  return {
    allocations: new Map<string, Allocation>(),
    byAttempt: new Map<string, string>(),
    releases: new Map<string, AllocationReleaseReceipt>(),
    reservedCpuMillis: 0,
    reservedMemoryMiB: 0,
    revision: 0,
    rollbacks: new Map<string, ReservationRollbackReceipt>(),
    sequence: 0,
    totalCpuMillis: 1000,
    totalMemoryMiB: 1024,
    terminalReleases: new Map<string, TerminalReleaseReceipt>(),
  };
}

const transferMutationFence: MutationFence = Object.freeze({
  attemptId: "attempt-transfer-1",
  clusterIncarnation: "synthetic-phase1-cluster",
  clusterIncarnationVersion: 1,
  desiredEffect: "process_start",
  effectScopeKey: "process:attempt-transfer-1",
  executionGeneration: "generation-transfer-1",
  expectedDesiredVersion: 1,
  issuedStartRevocationRevision: 0,
  namespaceId: "namespace-1",
  namespaceWriterEpoch: 1,
  operationGateRevision: 1,
  requiredGate: "process_start",
  schemaVersion: 1,
  startFence: "start-transfer-1",
  supersessionKey: "process:attempt-transfer-1",
});

describe("Phase 2 disposable Postgres/SQLite persistence contracts", () => {
  it("recovers an ambiguous external witness append by exact lookup", () => {
    const state = {
      ambiguousNextAppend: true,
      available: true,
      records: new Map<string, WitnessRecord>(),
    };
    const pending = createAcceptanceDurabilityReceipt(
      "submit-witness-1",
      "incarnation-1",
      "externally_witnessed",
      1,
      "wal-1",
    );
    const adapter = createSyntheticExternalWitness(state);
    expect(reconcileAcceptanceWitness(pending, adapter)).toBe(pending);
    expect(reconcileAcceptanceWitness(pending, adapter).state).toBe(
      "witness_confirmed",
    );
    expect(state.records.size).toBe(1);
  });

  it.each([
    ["postgres", createPostgresCapacityReservationLedgerStore],
    ["sqlite", createSqliteCapacityReservationLedgerStore],
  ] as const)(
    "%s capacity ledger survives adapter restart without overcommit",
    (_profile, create) => {
      const state = capacityState();
      const first = create(state);
      const allocation = first.reserve({
        attemptId: "attempt-1",
        executionGeneration: "generation-1",
        request: { cpuMillis: 700, memoryMiB: 700 },
      });
      expect(() =>
        first.reserve({
          attemptId: "attempt-2",
          executionGeneration: "generation-2",
          request: { cpuMillis: 400, memoryMiB: 400 },
        }),
      ).toThrow("overcommit");
      const reopened = create(state);
      const receipt = reopened.release(allocation.allocationId);
      expect(reopened.release(allocation.allocationId)).toBe(receipt);
      expect(reopened.snapshot()).toMatchObject({
        reservedCpuMillis: 0,
        reservedMemoryMiB: 0,
      });
    },
  );

  it.each([
    ["postgres", createPostgresNamespaceOwnershipStore],
    ["sqlite", createSqliteNamespaceOwnershipStore],
  ] as const)(
    "%s NamespaceOwnership CAS persists across restart",
    (_profile, create) => {
      const state = { rows: new Map<string, NamespaceOwnership>() };
      const store = create(state);
      const initial: NamespaceOwnership = Object.freeze({
        namespaceId: "namespace-1",
        version: 1,
        writerEpoch: 1,
        writerId: "writer-a",
        writerRelease: "release-a",
      });
      store.create(initial);
      const next = Object.freeze({ ...initial, version: 2, writerEpoch: 2 });
      store.compareAndSet("namespace-1", 1, next);
      const reopened = create(state);
      expect(reopened.get("namespace-1")).toEqual(next);
      expect(() => reopened.compareAndSet("namespace-1", 1, next)).toThrow(
        "ownership_conflict",
      );
    },
  );

  it.each([
    ["postgres", createPostgresCapacityReservationLedgerStore],
    ["sqlite", createSqliteCapacityReservationLedgerStore],
  ] as const)(
    "%s finalizes every terminal disposition under one owner-safe release key",
    (_profile, create) => {
      for (const disposition of [
        "succeeded",
        "failed",
        "publication_failure",
        "lost",
        "canceled",
      ] as const) {
        const state = capacityState();
        const store = create(state);
        const allocation = store.reserve({
          attemptId: `attempt-${disposition}`,
          executionGeneration: `generation-${disposition}`,
          request: { cpuMillis: 100, memoryMiB: 100 },
        });
        const request = {
          allocationId: allocation.allocationId,
          attemptId: allocation.attemptId,
          barrierEvidenceDigest: `barrier-${disposition}`,
          executionGeneration: allocation.executionGeneration,
          intent: {
            allocationId: allocation.allocationId,
            creatingOperationId: `terminal-${disposition}`,
            disposition,
            evidenceDigest: `evidence-${disposition}`,
            evidenceKind: "synthetic_terminal",
            evidenceVersion: 1,
            executionGeneration: allocation.executionGeneration,
            precedenceDecision:
              disposition === "canceled"
                ? ("cancellation_won" as const)
                : ("completion_won" as const),
            terminalizationIntentId: `intent-${disposition}`,
          },
          participantDigests: {
            audit: "audit",
            capacity: "capacity",
            staging: "staging",
            tenant: "tenant",
          },
          stagingDisposition:
            disposition === "publication_failure"
              ? ("quarantined" as const)
              : ("discarded" as const),
        };
        const receipt = store.releaseTerminal(request);
        expect(create(state).releaseTerminal(request)).toBe(receipt);
        expect(state.reservedCpuMillis).toBe(0);
        expect(receipt).toMatchObject({
          disposition,
          terminalizationIntentId: `intent-${disposition}`,
        });
      }
    },
  );

  it.each([
    ["postgres", createPostgresCapacityReservationLedgerStore],
    ["sqlite", createSqliteCapacityReservationLedgerStore],
  ] as const)(
    "%s rejects false no-Allocation proof after any Allocation history",
    (_profile, create) => {
      const state = capacityState();
      const store = create(state);
      store.reserve({
        attemptId: "attempt-history",
        executionGeneration: "generation-history",
        request: { cpuMillis: 100, memoryMiB: 100 },
      });
      expect(() =>
        store.releaseTerminal({
          attemptId: "attempt-history",
          barrierEvidenceDigest: "absence",
          executionGeneration: "generation-history",
          intent: {
            creatingOperationId: "terminal-history",
            disposition: "canceled",
            evidenceDigest: "absence",
            evidenceKind: "absence",
            evidenceVersion: 1,
            executionGeneration: "generation-history",
            precedenceDecision: "cancellation_won",
            terminalizationIntentId: "intent-history",
          },
          participantDigests: {},
          stagingDisposition: "empty",
        }),
      ).toThrow("false_no_allocation_proof");
    },
  );

  it.each([
    [
      "postgres",
      createInMemoryPostgresOwnershipTransferCoordinatorStoreTestFake,
    ],
    ["sqlite", createInMemorySqliteOwnershipTransferCoordinatorStoreTestFake],
  ] as const)(
    "%s discovers and resumes post-CAS transfer forward",
    (_profile, create) => {
      const rows = new Map<string, OwnershipTransferCoordinator>();
      const store = create(rows);
      let coordinator = store.create(
        createOwnershipTransferCoordinator({
          authorityIds: ["launcher-1"],
          gateRevision: 1,
          mutationFence: transferMutationFence,
          namespaceId: "namespace-1",
          operationId: "transfer-1",
          ownershipVersion: 1,
          targetWriterId: "writer-b",
          targetWriterRelease: "release-b",
        }),
      );
      for (const step of [
        "gates_closed",
        "old_effects_drained",
        "old_authorities_fenced",
        "epoch_advanced",
      ] as const) {
        const next = advanceOwnershipTransferCoordinator(
          coordinator,
          step,
          step,
        );
        coordinator = store.save(coordinator.version, next);
      }
      const reopened = create(rows);
      expect(reopened.discoverIncomplete(undefined, 10)).toEqual([coordinator]);
      expect(() =>
        advanceOwnershipTransferCoordinator(coordinator, "aborted", "failure"),
      ).toThrow("post_cas_transfer_cannot_abort");
    },
  );
});
