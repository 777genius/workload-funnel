import type { ReconciliationClaim } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface OwnershipTransferOperation {
  readonly operationId: string;
  readonly namespaceId: string;
  readonly state: "pending" | "epoch_advanced" | "completed";
  readonly steps: readonly string[];
  readonly acknowledgements: readonly string[];
  readonly version: number;
}

export interface OwnershipTransferCoordinatorStore {
  create(operationId: string, namespaceId: string): OwnershipTransferOperation;
  get(operationId: string): OwnershipTransferOperation | undefined;
  discoverIncomplete(): readonly OwnershipTransferOperation[];
  recordStep(
    operationId: string,
    step: string,
    claim: ReconciliationClaim,
    now: number,
  ): OwnershipTransferOperation;
  recordAuthorityAcknowledgement(
    operationId: string,
    authorityId: string,
    claim: ReconciliationClaim,
    now: number,
  ): OwnershipTransferOperation;
  complete(
    operationId: string,
    claim: ReconciliationClaim,
    now: number,
  ): OwnershipTransferOperation;
}
