import type {
  ReconciliationClaim,
  ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface ReconciliationClaimState {
  readonly claims: Map<string, ReconciliationClaim>;
  nextFence(): number;
}

export function createSqliteReconciliationClaimStore(
  state: ReconciliationClaimState,
): ReconciliationClaimStore {
  const store: ReconciliationClaimStore = {
    assertCurrent(claim, now) {
      const current = state.claims.get(claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      ) {
        throw new Error("Stale reconciliation claim");
      }
    },
    claim(operationId, workerId, leaseUntil, now, expectedClaimFence) {
      const current = state.claims.get(operationId);
      if ((current?.fence ?? 0) !== expectedClaimFence)
        throw new Error("Stale expected reconciliation claim fence");
      if (
        current !== undefined &&
        current.leaseUntil > now &&
        current.workerId !== workerId
      ) {
        throw new Error("Reconciliation operation is already claimed");
      }
      const claim = Object.freeze({
        fence: state.nextFence(),
        leaseUntil,
        operationId,
        workerId,
      });
      state.claims.set(operationId, claim);
      return claim;
    },
    release(claim) {
      const current = state.claims.get(claim.operationId);
      if (current?.fence !== claim.fence)
        throw new Error("Stale reconciliation claim");
      state.claims.delete(claim.operationId);
    },
    renew(claim, leaseUntil, now) {
      const current = state.claims.get(claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      ) {
        throw new Error("Stale reconciliation claim");
      }
      const renewed = Object.freeze({ ...claim, leaseUntil });
      state.claims.set(claim.operationId, renewed);
      return renewed;
    },
  };
  return Object.freeze(store);
}
