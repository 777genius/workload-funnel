import type {
  ReconciliationClaim,
  ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

import type {
  OwnershipTransferCoordinatorStore,
  OwnershipTransferOperation,
} from "../domain/ownership-transfer-operation.js";

export interface OwnershipTransferService {
  begin(operationId: string, namespaceId: string): OwnershipTransferOperation;
  claim(
    operationId: string,
    workerId: string,
    now: number,
    leaseUntil: number,
    expectedClaimFence: number,
  ): ReconciliationClaim;
  recordStep(
    operationId: string,
    step: string,
    claim: ReconciliationClaim,
    now: number,
  ): OwnershipTransferOperation;
  acknowledge(
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
  discoverIncomplete(): readonly OwnershipTransferOperation[];
}

export function createOwnershipTransferService(
  coordinatorStore: OwnershipTransferCoordinatorStore,
  claimStore: ReconciliationClaimStore,
): OwnershipTransferService {
  const service: OwnershipTransferService = {
    acknowledge: (operationId, authorityId, claim, now) =>
      coordinatorStore.recordAuthorityAcknowledgement(
        operationId,
        authorityId,
        claim,
        now,
      ),
    begin: (operationId, namespaceId) =>
      coordinatorStore.create(operationId, namespaceId),
    claim: (operationId, workerId, now, leaseUntil, expectedClaimFence) =>
      claimStore.claim(
        operationId,
        workerId,
        leaseUntil,
        now,
        expectedClaimFence,
      ),
    complete: (operationId, claim, now) =>
      coordinatorStore.complete(operationId, claim, now),
    discoverIncomplete: () => coordinatorStore.discoverIncomplete(),
    recordStep: (operationId, step, claim, now) =>
      coordinatorStore.recordStep(operationId, step, claim, now),
  };
  return Object.freeze(service);
}
