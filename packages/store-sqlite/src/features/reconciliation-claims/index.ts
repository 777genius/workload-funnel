import { DatabaseSync } from "node:sqlite";

import type {
  ReconciliationClaim,
  ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface OpenSqliteReconciliationClaimStore {
  readonly store: ReconciliationClaimStore;
  close(): void;
}

export interface InMemorySqliteReconciliationClaimTestState {
  readonly claims: Map<string, ReconciliationClaim>;
  nextFence(): number;
}

interface ClaimRow {
  readonly operation_id: string;
  readonly worker_id: string;
  readonly fence: number;
  readonly lease_until: number;
}

function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS reconciliation_claim (
      operation_id TEXT PRIMARY KEY,
      worker_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK (fence > 0),
      lease_until INTEGER NOT NULL CHECK (lease_until >= 0)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS reconciliation_claim_fence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      next_fence INTEGER NOT NULL CHECK (next_fence >= 0)
    ) STRICT;
    INSERT INTO reconciliation_claim_fence (singleton, next_fence)
      VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING;
  `);
}

function transaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function get(
  database: DatabaseSync,
  operationId: string,
): ReconciliationClaim | undefined {
  const row = database
    .prepare(
      "SELECT operation_id, worker_id, fence, lease_until FROM reconciliation_claim WHERE operation_id = ?",
    )
    .get(operationId) as ClaimRow | undefined;
  return row === undefined
    ? undefined
    : Object.freeze({
        fence: row.fence,
        leaseUntil: row.lease_until,
        operationId: row.operation_id,
        workerId: row.worker_id,
      });
}

export function createSqliteReconciliationClaimStore(
  database: DatabaseSync,
): ReconciliationClaimStore {
  migrate(database);
  const store: ReconciliationClaimStore = {
    assertCurrent(claim, now) {
      const current = get(database, claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now
      )
        throw new Error("Stale reconciliation claim");
    },
    claim(operationId, workerId, leaseUntil, now, expectedClaimFence) {
      if (leaseUntil <= now) throw new Error("Invalid reconciliation lease");
      return transaction(database, () => {
        const current = get(database, operationId);
        if ((current?.fence ?? 0) !== expectedClaimFence)
          throw new Error("Stale expected reconciliation claim fence");
        if (
          current !== undefined &&
          current.leaseUntil > now &&
          current.workerId !== workerId
        )
          throw new Error("Reconciliation operation is already claimed");
        const next = database
          .prepare(
            "UPDATE reconciliation_claim_fence SET next_fence = next_fence + 1 WHERE singleton = 1 RETURNING next_fence",
          )
          .get() as Readonly<{ next_fence: number }>;
        const claim = Object.freeze({
          fence: next.next_fence,
          leaseUntil,
          operationId,
          workerId,
        });
        database
          .prepare(
            `INSERT INTO reconciliation_claim (operation_id, worker_id, fence, lease_until)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(operation_id) DO UPDATE SET
               worker_id = excluded.worker_id,
               fence = excluded.fence,
               lease_until = excluded.lease_until`,
          )
          .run(operationId, workerId, claim.fence, leaseUntil);
        return claim;
      });
    },
    release(claim) {
      if (
        database
          .prepare(
            "DELETE FROM reconciliation_claim WHERE operation_id = ? AND fence = ? AND worker_id = ?",
          )
          .run(claim.operationId, claim.fence, claim.workerId).changes !== 1
      )
        throw new Error("Stale reconciliation claim");
    },
    renew(claim, leaseUntil, now) {
      if (leaseUntil <= now) throw new Error("Invalid reconciliation lease");
      const current = get(database, claim.operationId);
      if (
        current?.fence !== claim.fence ||
        current.workerId !== claim.workerId ||
        current.leaseUntil <= now ||
        database
          .prepare(
            "UPDATE reconciliation_claim SET lease_until = ? WHERE operation_id = ? AND fence = ? AND worker_id = ?",
          )
          .run(leaseUntil, claim.operationId, claim.fence, claim.workerId)
          .changes !== 1
      )
        throw new Error("Stale reconciliation claim");
      return Object.freeze({ ...claim, leaseUntil });
    },
  };
  return Object.freeze(store);
}

export function openSqliteReconciliationClaimStore(
  path: string,
): OpenSqliteReconciliationClaimStore {
  const database = new DatabaseSync(path);
  const opened: OpenSqliteReconciliationClaimStore = {
    close: () => {
      database.close();
    },
    store: createSqliteReconciliationClaimStore(database),
  };
  return Object.freeze(opened);
}

export function createInMemorySqliteReconciliationClaimStoreTestFake(
  state: InMemorySqliteReconciliationClaimTestState,
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
