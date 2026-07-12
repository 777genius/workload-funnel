export {
  CapacityUnavailableError,
  type Allocation,
  type AllocationReleaseReceipt,
  type NoAllocationReleaseReceipt,
  type StagingDisposition,
  type TerminalReleaseReceipt,
  type CapacitySnapshot,
  type ReservationRollbackReceipt,
} from "./domain/allocation.js";
export {
  InvalidAllocationLeaseTransitionError,
  StaleAllocationOwnerError,
  claimAllocationLease,
  observeLeaseExpired,
  renewAllocationLease,
  revokeAllocationLease,
  takeOverAllocationLease,
  transitionAllocationLifecycle,
} from "./domain/allocation.js";
export {
  createTerminalReleaseReceiptStore,
  terminalReleaseKey,
  type TerminalReleaseReceiptStore,
  type TerminalReleaseRequest,
} from "./application/terminal-release.js";
export type {
  CapacityReservationLedgerStore,
  OwnerSafeCapacityReservationLedgerStore,
  ReserveAllocationInput,
} from "./application/contracts/capacity-reservation-ledger-store.js";
export {
  createAllocationService,
  createAllocationEffectCommand,
  type AllocationEffectCommand,
  type AllocationService,
} from "./application/allocation-service.js";
export { createAllocationLeasingTransactionParticipant } from "./application/transaction-participant.js";
export {
  HardResourceOvercommitError,
  SerializedCapacityReservationLedger,
  StaleCapacityDecisionError,
  type CapacityLedgerSnapshot,
  type ReservationResources,
  type ReserveResourcesCommand,
  type ResourceReservation,
} from "./domain/resource-reservation-ledger.js";
export {
  AdmissionCoordinator,
  type CapacitySource,
  type CommittedAdmission,
} from "./application/admission-coordinator.js";
