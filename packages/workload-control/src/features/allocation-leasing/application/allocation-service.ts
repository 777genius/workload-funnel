import type { Attempt } from "@workload-funnel/workload-control/workload-lifecycle";

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
  activate(allocationId: string): Allocation;
  rejectAttachment(allocationId: string): ReservationRollbackReceipt;
  release(allocationId: string): AllocationReleaseReceipt;
  snapshot(): CapacitySnapshot;
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
    activate: (allocationId) => ledger.activate(allocationId),
    rejectAttachment: (allocationId) => ledger.rollbackAttachment(allocationId),
    release: (allocationId) => ledger.release(allocationId),
    snapshot: () => ledger.snapshot(),
  };
  return Object.freeze(service);
}
