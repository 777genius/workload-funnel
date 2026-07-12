import type {
  Allocation,
  AllocationReleaseReceipt,
  CapacitySnapshot,
  ReservationRollbackReceipt,
  TerminalReleaseReceipt,
} from "../../domain/allocation.js";
import type { TerminalReleaseRequest } from "../terminal-release.js";
import type { ResourceRequest } from "@workload-funnel/workload-control/workload-lifecycle";

export interface ReserveAllocationInput {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly request: ResourceRequest;
}

export interface CapacityReservationLedgerStore {
  snapshot(): CapacitySnapshot;
  reserve(input: ReserveAllocationInput): Allocation;
  getByAttempt(attemptId: string): Allocation | undefined;
  activate(allocationId: string): Allocation;
  rollbackAttachment(allocationId: string): ReservationRollbackReceipt;
  release(allocationId: string): AllocationReleaseReceipt;
  releaseReceipt(allocationId: string): AllocationReleaseReceipt | undefined;
}

export interface OwnerSafeCapacityReservationLedgerStore extends CapacityReservationLedgerStore {
  releaseTerminal(request: TerminalReleaseRequest): TerminalReleaseReceipt;
  terminalReleaseReceipt(
    attemptId: string,
    executionGeneration: string,
    terminalizationIntentId: string,
  ): TerminalReleaseReceipt | undefined;
}
