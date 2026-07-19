import {
  CapacityUnavailableError,
  type Allocation,
  type AllocationReleaseReceipt,
  createTerminalReleaseReceiptStore,
  terminalReleaseKey,
  type OwnerSafeCapacityReservationLedgerStore,
  type ReserveAllocationInput,
  type ReservationRollbackReceipt,
  type TerminalReleaseReceipt,
  type TerminalReleaseRequest,
} from "@workload-funnel/workload-control/allocation-leasing";

export {
  createAsyncPostgresCapacityReservationStore,
  type AsyncPostgresCapacityReservationStore,
  type DurableAllocation,
  type DurableCapacitySnapshot,
  type PostgresCapacityExecutor,
} from "./async-postgres-capacity-store.js";

export interface PostgresCapacityLedgerState {
  readonly allocations: Map<string, Allocation>;
  readonly byAttempt: Map<string, string>;
  readonly releases: Map<string, AllocationReleaseReceipt>;
  readonly rollbacks: Map<string, ReservationRollbackReceipt>;
  readonly terminalReleases: Map<string, TerminalReleaseReceipt>;
  sequence: number;
  revision: number;
  reservedCpuMillis: number;
  reservedMemoryMiB: number;
  readonly totalCpuMillis: number;
  readonly totalMemoryMiB: number;
}

export function createPostgresCapacityReservationLedgerStore(
  state: PostgresCapacityLedgerState,
): OwnerSafeCapacityReservationLedgerStore {
  const receiptFactory = createTerminalReleaseReceiptStore();
  function allocation(id: string): Allocation {
    const value = state.allocations.get(id);
    if (value === undefined) throw new Error("allocation_not_found");
    return value;
  }
  function releaseCapacity(value: Allocation): void {
    if (value.state === "released") return;
    state.reservedCpuMillis -= value.resources.cpuMillis;
    state.reservedMemoryMiB -= value.resources.memoryMiB;
    state.revision += 1;
    state.allocations.set(
      value.allocationId,
      Object.freeze({
        ...value,
        state: "released",
        version: value.version + 1,
      }),
    );
  }
  const store: OwnerSafeCapacityReservationLedgerStore = {
    snapshot: () =>
      Object.freeze({
        reservedCpuMillis: state.reservedCpuMillis,
        reservedMemoryMiB: state.reservedMemoryMiB,
        revision: state.revision,
        totalCpuMillis: state.totalCpuMillis,
        totalMemoryMiB: state.totalMemoryMiB,
      }),
    reserve(input: ReserveAllocationInput) {
      const id = state.byAttempt.get(input.attemptId);
      if (id !== undefined) return allocation(id);
      if (
        state.reservedCpuMillis + input.request.cpuMillis >
          state.totalCpuMillis ||
        state.reservedMemoryMiB + input.request.memoryMiB > state.totalMemoryMiB
      )
        throw new CapacityUnavailableError();
      const value: Allocation = Object.freeze({
        allocationId: `pg-allocation-${String(++state.sequence)}`,
        attemptId: input.attemptId,
        executionGeneration: input.executionGeneration,
        leaseState: "unowned",
        nodeId: "synthetic-node-1",
        ownerFence: 0,
        resources: input.request,
        state: "reserved",
        version: 1,
      });
      state.allocations.set(value.allocationId, value);
      state.byAttempt.set(value.attemptId, value.allocationId);
      state.reservedCpuMillis += value.resources.cpuMillis;
      state.reservedMemoryMiB += value.resources.memoryMiB;
      state.revision += 1;
      return value;
    },
    getByAttempt(attemptId: string) {
      const id = state.byAttempt.get(attemptId);
      return id === undefined ? undefined : state.allocations.get(id);
    },
    activate(id: string) {
      const prior = allocation(id);
      if (prior.state === "active") return prior;
      const value: Allocation = Object.freeze({
        ...prior,
        state: "active",
        version: prior.version + 1,
      });
      state.allocations.set(id, value);
      return value;
    },
    rollbackAttachment(id: string) {
      const prior = state.rollbacks.get(id);
      if (prior !== undefined) return prior;
      const value = allocation(id);
      releaseCapacity(value);
      const receipt: ReservationRollbackReceipt = Object.freeze({
        allocationId: id,
        attemptId: value.attemptId,
        kind: "nonterminal_attachment_rollback",
        reservationRevision: state.revision,
      });
      state.rollbacks.set(id, receipt);
      return receipt;
    },
    release(id: string) {
      const prior = state.releases.get(id);
      if (prior !== undefined) return prior;
      const value = allocation(id);
      releaseCapacity(value);
      const receipt: AllocationReleaseReceipt = Object.freeze({
        allocationId: id,
        attemptId: value.attemptId,
        executionGeneration: value.executionGeneration,
        kind: "terminal_release",
        proofId: `postgres-release:${id}`,
      });
      state.releases.set(id, receipt);
      return receipt;
    },
    releaseReceipt: (id: string) => state.releases.get(id),
    releaseTerminal(request: TerminalReleaseRequest) {
      const key = terminalReleaseKey(request);
      const prior = state.terminalReleases.get(key);
      if (prior !== undefined) {
        const candidate = receiptFactory.release(request);
        if (JSON.stringify(candidate) !== JSON.stringify(prior)) {
          throw new Error("release_key_conflict");
        }
        return prior;
      }
      const historicalId = state.byAttempt.get(request.attemptId);
      if (request.allocationId === undefined) {
        if (historicalId !== undefined)
          throw new Error("false_no_allocation_proof");
      } else {
        if (historicalId !== request.allocationId)
          throw new Error("allocation_history_mismatch");
        const value = allocation(request.allocationId);
        if (value.executionGeneration !== request.executionGeneration) {
          throw new Error("release_key_conflict");
        }
      }
      const receipt = receiptFactory.release(request);
      if (request.allocationId !== undefined)
        releaseCapacity(allocation(request.allocationId));
      state.terminalReleases.set(key, receipt);
      return receipt;
    },
    terminalReleaseReceipt: (
      attemptId: string,
      executionGeneration: string,
      terminalizationIntentId: string,
    ) =>
      state.terminalReleases.get(
        `${attemptId}/${executionGeneration}/${terminalizationIntentId}`,
      ),
  };
  return Object.freeze(store);
}
