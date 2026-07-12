import type { ReconciliationClaimStore } from "@workload-funnel/workload-control/canonical-transaction-coordination";
import type { OwnershipTransferCoordinatorStore } from "@workload-funnel/workload-control/ownership-transfer";

import type { DurableState } from "./synthetic-state.js";

export function ownershipTransferCoordinatorStore(
  state: DurableState,
  claims: ReconciliationClaimStore,
): OwnershipTransferCoordinatorStore {
  function current(operationId: string) {
    const operation = state.ownershipTransfers.get(operationId);
    if (operation === undefined)
      throw new Error("Ownership transfer operation does not exist");
    return operation;
  }
  return {
    complete(operationId, claim, now) {
      claims.assertCurrent(claim, now);
      const operation = current(operationId);
      if (operation.state !== "epoch_advanced")
        throw new Error(
          "Ownership transfer cannot complete before epoch advance",
        );
      const completed = Object.freeze({
        ...operation,
        state: "completed" as const,
        version: operation.version + 1,
      });
      state.ownershipTransfers.set(operationId, completed);
      claims.release(claim);
      return completed;
    },
    create(operationId, namespaceId) {
      const prior = state.ownershipTransfers.get(operationId);
      if (prior !== undefined) return prior;
      const operation = Object.freeze({
        acknowledgements: Object.freeze([]),
        namespaceId,
        operationId,
        state: "pending" as const,
        steps: Object.freeze([]),
        version: 1,
      });
      state.ownershipTransfers.set(operationId, operation);
      return operation;
    },
    discoverIncomplete: () =>
      [...state.ownershipTransfers.values()].filter(
        (operation) => operation.state !== "completed",
      ),
    get: (operationId) => state.ownershipTransfers.get(operationId),
    recordAuthorityAcknowledgement(operationId, authorityId, claim, now) {
      claims.assertCurrent(claim, now);
      const operation = current(operationId);
      if (operation.state !== "epoch_advanced")
        throw new Error("Authority acknowledgement requires epoch advance");
      if (operation.acknowledgements.includes(authorityId)) return operation;
      const updated = Object.freeze({
        ...operation,
        acknowledgements: Object.freeze([
          ...operation.acknowledgements,
          authorityId,
        ]),
        version: operation.version + 1,
      });
      state.ownershipTransfers.set(operationId, updated);
      return updated;
    },
    recordStep(operationId, step, claim, now) {
      claims.assertCurrent(claim, now);
      const operation = current(operationId);
      if (operation.steps.includes(step)) return operation;
      const epochAdvanced = step === "epoch-advanced";
      const updated = Object.freeze({
        ...operation,
        state: epochAdvanced ? ("epoch_advanced" as const) : operation.state,
        steps: Object.freeze([...operation.steps, step]),
        version: operation.version + 1,
      });
      state.ownershipTransfers.set(operationId, updated);
      return updated;
    },
  };
}
