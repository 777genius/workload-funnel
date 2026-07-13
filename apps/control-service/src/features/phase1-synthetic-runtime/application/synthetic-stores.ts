import {
  CapacityUnavailableError,
  type CapacityReservationLedgerStore,
} from "@workload-funnel/workload-control/allocation-leasing";
import type { DispatchStore } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { ExecutionStore } from "@workload-funnel/workload-control/execution-reconciliation";
import { createStaticSyntheticNode } from "@workload-funnel/workload-control/node-lifecycle";
import type { ResultStore } from "@workload-funnel/workload-control/result-management";

import type { DurableState } from "./synthetic-state.js";

export function capacityLedger(
  state: DurableState,
): CapacityReservationLedgerStore {
  const totalCpuMillis = createStaticSyntheticNode().capacity.cpuMillis;
  const totalMemoryMiB = createStaticSyntheticNode().capacity.memoryMiB;
  return {
    activate(allocationId) {
      const allocation = state.allocations.get(allocationId);
      if (allocation === undefined)
        throw new Error("Allocation does not exist");
      if (allocation.state === "active") return allocation;
      const active = Object.freeze({
        ...allocation,
        state: "active" as const,
        version: allocation.version + 1,
      });
      state.allocations.set(allocationId, active);
      return active;
    },
    getByAttempt(attemptId) {
      const id = state.allocationByAttempt.get(attemptId);
      return id === undefined ? undefined : state.allocations.get(id);
    },
    release(allocationId) {
      const priorReceipt = state.releaseReceipts.get(allocationId);
      if (priorReceipt !== undefined) return priorReceipt;
      const allocation = state.allocations.get(allocationId);
      if (allocation === undefined)
        throw new Error("Allocation does not exist");
      if (allocation.state !== "released") {
        state.reservedCpuMillis -= allocation.resources.cpuMillis;
        state.reservedMemoryMiB -= allocation.resources.memoryMiB;
        state.reservationRevision += 1;
        state.allocations.set(
          allocationId,
          Object.freeze({
            ...allocation,
            state: "released",
            version: allocation.version + 1,
          }),
        );
      }
      const receipt = Object.freeze({
        allocationId,
        attemptId: allocation.attemptId,
        executionGeneration: allocation.executionGeneration,
        kind: "terminal_release" as const,
        proofId: `release:${allocationId}`,
      });
      state.releaseReceipts.set(allocationId, receipt);
      return receipt;
    },
    releaseReceipt: (allocationId) => state.releaseReceipts.get(allocationId),
    reserve(input) {
      const currentId = state.allocationByAttempt.get(input.attemptId);
      const current =
        currentId === undefined ? undefined : state.allocations.get(currentId);
      if (current !== undefined && current.state !== "released") return current;
      if (
        state.reservedCpuMillis + input.request.cpuMillis > totalCpuMillis ||
        state.reservedMemoryMiB + input.request.memoryMiB > totalMemoryMiB
      ) {
        throw new CapacityUnavailableError();
      }
      const allocationId = `allocation-${String(++state.allocationSequence).padStart(4, "0")}`;
      const allocation = Object.freeze({
        allocationId,
        attemptId: input.attemptId,
        executionGeneration: input.executionGeneration,
        nodeId: "synthetic-node-1" as const,
        leaseState: "unowned" as const,
        ownerFence: 0,
        resources: input.request,
        state: "reserved" as const,
        version: 1,
      });
      state.allocations.set(allocationId, allocation);
      state.allocationByAttempt.set(input.attemptId, allocationId);
      state.reservedCpuMillis += input.request.cpuMillis;
      state.reservedMemoryMiB += input.request.memoryMiB;
      state.reservationRevision += 1;
      return allocation;
    },
    rollbackAttachment(allocationId) {
      const prior = state.rollbackReceipts.get(allocationId);
      if (prior !== undefined) return prior;
      const allocation = state.allocations.get(allocationId);
      if (allocation === undefined)
        throw new Error("Allocation does not exist");
      state.reservedCpuMillis -= allocation.resources.cpuMillis;
      state.reservedMemoryMiB -= allocation.resources.memoryMiB;
      state.reservationRevision += 1;
      state.allocations.set(
        allocationId,
        Object.freeze({
          ...allocation,
          state: "released",
          version: allocation.version + 1,
        }),
      );
      const receipt = Object.freeze({
        allocationId,
        attemptId: allocation.attemptId,
        kind: "nonterminal_attachment_rollback" as const,
        reservationRevision: state.reservationRevision,
      });
      state.rollbackReceipts.set(allocationId, receipt);
      return receipt;
    },
    snapshot: () =>
      Object.freeze({
        reservedCpuMillis: state.reservedCpuMillis,
        reservedMemoryMiB: state.reservedMemoryMiB,
        revision: state.reservationRevision,
        totalCpuMillis,
        totalMemoryMiB,
      }),
  };
}

export function dispatchStore(state: DurableState): DispatchStore {
  return {
    create(dispatch, mapping) {
      const priorId = state.dispatchByAllocation.get(dispatch.allocationId);
      if (priorId !== undefined)
        return state.dispatches.get(priorId) ?? dispatch;
      state.dispatches.set(dispatch.dispatchId, dispatch);
      state.dispatchByAllocation.set(
        dispatch.allocationId,
        dispatch.dispatchId,
      );
      state.mappings.set(dispatch.dispatchId, mapping);
      return dispatch;
    },
    getByAllocation(allocationId) {
      const id = state.dispatchByAllocation.get(allocationId);
      return id === undefined ? undefined : state.dispatches.get(id);
    },
    mapping: (dispatchId) => state.mappings.get(dispatchId),
    save: (dispatch) => state.dispatches.set(dispatch.dispatchId, dispatch),
  };
}

export function executionStore(state: DurableState): ExecutionStore {
  return {
    create(execution) {
      const priorId = state.executionByDispatch.get(execution.dispatchId);
      if (priorId !== undefined)
        return state.executions.get(priorId) ?? execution;
      state.executions.set(execution.executionId, execution);
      state.executionByDispatch.set(
        execution.dispatchId,
        execution.executionId,
      );
      return execution;
    },
    getByDispatch(dispatchId) {
      const id = state.executionByDispatch.get(dispatchId);
      return id === undefined ? undefined : state.executions.get(id);
    },
    save: (execution) => state.executions.set(execution.executionId, execution),
  };
}

export function resultStore(state: DurableState): ResultStore {
  return {
    create(manifest) {
      const priorId = state.manifestByAttempt.get(manifest.attemptId);
      if (priorId !== undefined)
        return state.manifests.get(priorId) ?? manifest;
      state.manifests.set(manifest.resultManifestId, manifest);
      state.manifestByAttempt.set(
        manifest.attemptId,
        manifest.resultManifestId,
      );
      return manifest;
    },
    getByAttempt(attemptId) {
      const id = state.manifestByAttempt.get(attemptId);
      return id === undefined ? undefined : state.manifests.get(id);
    },
    get: (resultManifestId) => state.manifests.get(resultManifestId),
    save(manifest, expectedVersion) {
      const prior = state.manifests.get(manifest.resultManifestId);
      if (prior?.version !== expectedVersion)
        throw new Error("result_version_conflict");
      state.manifests.set(manifest.resultManifestId, manifest);
      return manifest;
    },
  };
}
