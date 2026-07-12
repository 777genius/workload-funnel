import type { Attempt } from "@workload-funnel/workload-control/workload-lifecycle";
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import type { CapacityReservationLedgerStore } from "./contracts/capacity-reservation-ledger-store.js";
import type {
  Allocation,
  AllocationReleaseReceipt,
  CapacitySnapshot,
  ReservationRollbackReceipt,
} from "../domain/allocation.js";

export interface AllocationService {
  reserve(
    attempt: Attempt,
    request: { readonly cpuMillis: number; readonly memoryMiB: number },
  ): Allocation;
  activate(command: AllocationEffectCommand): Allocation;
  rejectAttachment(allocationId: string): ReservationRollbackReceipt;
  release(command: AllocationEffectCommand): AllocationReleaseReceipt;
  getByAttempt(attemptId: string): Allocation | undefined;
  snapshot(): CapacitySnapshot;
}

export interface AllocationEffectCommand {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly mutationFence: MutationFence;
}

export function createAllocationEffectCommand(
  allocationId: string,
  attemptId: string,
  mutationFence: MutationFence,
): AllocationEffectCommand {
  validateMutationFence(mutationFence);
  return Object.freeze({ allocationId, attemptId, mutationFence });
}

function assertAllocationEffectCommand(
  ledger: CapacityReservationLedgerStore,
  command: AllocationEffectCommand,
): void {
  validateMutationFence(command.mutationFence);
  const allocation = ledger.getByAttempt(command.attemptId);
  if (
    allocation?.allocationId !== command.allocationId ||
    command.mutationFence.allocationId !== allocation.allocationId ||
    command.mutationFence.ownerFence !== allocation.ownerFence ||
    command.mutationFence.attemptId !== allocation.attemptId ||
    command.mutationFence.executionGeneration !== allocation.executionGeneration
  ) {
    throw new Error("allocation_effect_fence_mismatch");
  }
}

export function createAllocationService(
  ledger: CapacityReservationLedgerStore,
): AllocationService {
  const service: AllocationService = {
    reserve: (attempt, request) =>
      ledger.reserve({
        attemptId: attempt.attemptId,
        executionGeneration: attempt.executionGeneration,
        request,
      }),
    activate: (command) => {
      assertAllocationEffectCommand(ledger, command);
      return ledger.activate(command.allocationId);
    },
    rejectAttachment: (allocationId) => ledger.rollbackAttachment(allocationId),
    release: (command) => {
      assertAllocationEffectCommand(ledger, command);
      return ledger.release(command.allocationId);
    },
    getByAttempt: (attemptId) => ledger.getByAttempt(attemptId),
    snapshot: () => ledger.snapshot(),
  };
  return Object.freeze(service);
}
