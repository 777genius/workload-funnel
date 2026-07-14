import type {
  ReconciliationClaim,
  ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface PostgresReconciliationClaimDriver {
  readonly capabilities: Readonly<{
    backend: string;
    crashSafe: boolean;
    multiWriter: boolean;
    serializableTransactions: boolean;
  }>;
  migrate(statements: readonly string[]): void;
  transaction<T>(callback: () => T): T;
  get(operationId: string): ReconciliationClaim | undefined;
  nextFence(): number;
  upsert(claim: ReconciliationClaim): void;
  delete(operationId: string, fence: number, workerId: string): boolean;
  renew(
    operationId: string,
    fence: number,
    workerId: string,
    leaseUntil: number,
  ): boolean;
}

export interface InMemoryPostgresReconciliationClaimTestState {
  readonly claims: Map<string, ReconciliationClaim>;
  nextFence(): number;
}

const migrations = Object.freeze([
  "CREATE SEQUENCE IF NOT EXISTS reconciliation_claim_fence_seq AS bigint",
  "CREATE TABLE IF NOT EXISTS reconciliation_claim (operation_id text PRIMARY KEY, worker_id text NOT NULL, fence bigint NOT NULL CHECK (fence > 0), lease_until bigint NOT NULL CHECK (lease_until >= 0))",
]);

export function createPostgresReconciliationClaimStore(
  driver: PostgresReconciliationClaimDriver,
): ReconciliationClaimStore {
  if (
    driver.capabilities.backend !== "postgres" ||
    !driver.capabilities.crashSafe ||
    !driver.capabilities.multiWriter ||
    !driver.capabilities.serializableTransactions
  )
    throw new Error("postgres_reconciliation_claim_driver_incapable");
  driver.migrate(migrations);
  const store: ReconciliationClaimStore = {
    assertCurrent(claim, now) {
      const current = driver.get(claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      )
        throw new Error("Stale reconciliation claim");
    },
    claim(operationId, workerId, leaseUntil, now, expectedClaimFence) {
      if (leaseUntil <= now) throw new Error("Invalid reconciliation lease");
      return driver.transaction(() => {
        const current = driver.get(operationId);
        if ((current?.fence ?? 0) !== expectedClaimFence)
          throw new Error("Stale expected reconciliation claim fence");
        if (
          current !== undefined &&
          current.leaseUntil > now &&
          current.workerId !== workerId
        )
          throw new Error("Reconciliation operation is already claimed");
        const claim = Object.freeze({
          fence: driver.nextFence(),
          leaseUntil,
          operationId,
          workerId,
        });
        driver.upsert(claim);
        return claim;
      });
    },
    release(claim) {
      if (!driver.delete(claim.operationId, claim.fence, claim.workerId))
        throw new Error("Stale reconciliation claim");
    },
    renew(claim, leaseUntil, now) {
      if (
        leaseUntil <= now ||
        (driver.get(claim.operationId)?.leaseUntil ?? -1) <= now ||
        !driver.renew(
          claim.operationId,
          claim.fence,
          claim.workerId,
          leaseUntil,
        )
      )
        throw new Error("Stale reconciliation claim");
      return Object.freeze({ ...claim, leaseUntil });
    },
  };
  return Object.freeze(store);
}

export function createInMemoryPostgresReconciliationClaimStoreTestFake(
  state: InMemoryPostgresReconciliationClaimTestState,
): ReconciliationClaimStore {
  const store: ReconciliationClaimStore = {
    assertCurrent(claim, now) {
      const current = state.claims.get(claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      )
        throw new Error("Stale reconciliation claim");
    },
    claim(operationId, workerId, leaseUntil, now, expectedClaimFence) {
      const current = state.claims.get(operationId);
      if ((current?.fence ?? 0) !== expectedClaimFence)
        throw new Error("Stale expected reconciliation claim fence");
      if (
        current !== undefined &&
        current.leaseUntil > now &&
        current.workerId !== workerId
      )
        throw new Error("Reconciliation operation is already claimed");
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
      if (state.claims.get(claim.operationId)?.fence !== claim.fence)
        throw new Error("Stale reconciliation claim");
      state.claims.delete(claim.operationId);
    },
    renew(claim, leaseUntil, now) {
      const current = state.claims.get(claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      )
        throw new Error("Stale reconciliation claim");
      const renewed = Object.freeze({ ...claim, leaseUntil });
      state.claims.set(claim.operationId, renewed);
      return renewed;
    },
  };
  return Object.freeze(store);
}
