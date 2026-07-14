import { DatabaseSync } from "node:sqlite";

import type {
  NodeMaintenanceOperation,
  NodeMaintenanceStore,
  NodeSnapshot,
  NodeStore,
} from "@workload-funnel/workload-control/node-lifecycle";

export interface SqliteNodePersistence {
  readonly nodes: NodeStore;
  readonly maintenance: NodeMaintenanceStore;
  close(): void;
}

interface SqliteRow {
  readonly version: number;
  readonly payload: string;
}

function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS phase8_node (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0),
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS phase8_node_maintenance (
      key TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0),
      payload TEXT NOT NULL
    ) STRICT;
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
  table: "phase8_node" | "phase8_node_maintenance",
  key: string,
): unknown {
  const result = database
    .prepare(`SELECT version, payload FROM ${table} WHERE key = ?`)
    .get(key) as SqliteRow | undefined;
  return result === undefined
    ? undefined
    : (JSON.parse(result.payload) as unknown);
}

function insert(
  database: DatabaseSync,
  table: "phase8_node" | "phase8_node_maintenance",
  key: string,
  version: number,
  value: unknown,
): boolean {
  return (
    database
      .prepare(
        `INSERT INTO ${table} (key, version, payload) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, version, JSON.stringify(value)).changes === 1
  );
}

function compareAndSet(
  database: DatabaseSync,
  table: "phase8_node" | "phase8_node_maintenance",
  key: string,
  expectedVersion: number,
  value: Readonly<{ version: number }>,
): boolean {
  return (
    database
      .prepare(
        `UPDATE ${table} SET version = ?, payload = ? WHERE key = ? AND version = ?`,
      )
      .run(value.version, JSON.stringify(value), key, expectedVersion)
      .changes === 1
  );
}

export function createProvider(database: DatabaseSync): NodeStore {
  migrate(database);
  const store: NodeStore = {
    compareAndSet(nodeId, expectedVersion, next) {
      if (
        next.nodeId !== nodeId ||
        next.version !== expectedVersion + 1 ||
        !transaction(database, () =>
          compareAndSet(database, "phase8_node", nodeId, expectedVersion, next),
        )
      )
        throw new Error("sqlite_node_version_conflict");
      return next;
    },
    create(node) {
      return transaction(database, () => {
        if (insert(database, "phase8_node", node.nodeId, node.version, node))
          return node;
        const current = get(database, "phase8_node", node.nodeId) as
          | NodeSnapshot
          | undefined;
        if (
          current === undefined ||
          JSON.stringify(current) !== JSON.stringify(node)
        )
          throw new Error("sqlite_node_identity_conflict");
        return current;
      });
    },
    get: (nodeId) =>
      get(database, "phase8_node", nodeId) as NodeSnapshot | undefined,
  };
  return Object.freeze(store);
}

export function createNodeMaintenanceProvider(
  database: DatabaseSync,
): NodeMaintenanceStore {
  migrate(database);
  const store: NodeMaintenanceStore = {
    claim(operationId, claimantId, expectedClaimFence, now, leaseUntil) {
      return transaction(database, () => {
        const current = get(
          database,
          "phase8_node_maintenance",
          operationId,
        ) as NodeMaintenanceOperation | undefined;
        if (current === undefined)
          throw new Error("node_maintenance_not_found");
        const priorFence = current.claim?.claimFence ?? 0;
        if (
          expectedClaimFence !== priorFence ||
          leaseUntil <= now ||
          (current.claim !== undefined &&
            current.claim.leaseUntil > now &&
            current.claim.claimantId !== claimantId)
        )
          throw new Error("node_maintenance_claim_conflict");
        const takeover =
          current.claim !== undefined &&
          current.claim.claimantId !== claimantId &&
          current.claim.leaseUntil <= now;
        const claimFence =
          current.claim === undefined
            ? 1
            : takeover
              ? current.claim.claimFence + 1
              : current.claim.claimFence;
        const claimed = Object.freeze({
          ...current,
          claim: Object.freeze({ claimFence, claimantId, leaseUntil }),
          version: current.version + 1,
        });
        if (
          !compareAndSet(
            database,
            "phase8_node_maintenance",
            operationId,
            current.version,
            claimed,
          )
        )
          throw new Error("node_maintenance_claim_conflict");
        return claimed;
      });
    },
    compareAndSet(expectedVersion, next, claim, now) {
      if (next.version !== expectedVersion + 1 || claim.leaseUntil <= now)
        throw new Error("stale_node_maintenance_claim");
      return transaction(database, () => {
        const current = get(
          database,
          "phase8_node_maintenance",
          next.operationId,
        ) as NodeMaintenanceOperation | undefined;
        const currentClaim = current?.claim;
        if (
          current?.version !== expectedVersion ||
          currentClaim?.claimFence !== claim.claimFence ||
          currentClaim.claimantId !== claim.claimantId ||
          currentClaim.leaseUntil !== claim.leaseUntil
        )
          throw new Error("stale_node_maintenance_claim");
        const persisted = Object.freeze({ ...next, claim: currentClaim });
        if (
          !compareAndSet(
            database,
            "phase8_node_maintenance",
            next.operationId,
            expectedVersion,
            persisted,
          )
        )
          throw new Error("stale_node_maintenance_claim");
        return persisted;
      });
    },
    create(operation) {
      return transaction(database, () => {
        if (
          insert(
            database,
            "phase8_node_maintenance",
            operation.operationId,
            operation.version,
            operation,
          )
        )
          return operation;
        const current = get(
          database,
          "phase8_node_maintenance",
          operation.operationId,
        ) as NodeMaintenanceOperation | undefined;
        if (
          current?.nodeId !== operation.nodeId ||
          current.kind !== operation.kind ||
          current.requestedBy !== operation.requestedBy ||
          current.reason !== operation.reason ||
          current.originalBootEpoch !== operation.originalBootEpoch
        )
          throw new Error("sqlite_node_maintenance_operation_conflict");
        return current;
      });
    },
    discoverIncomplete(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("invalid_node_maintenance_limit");
      return Object.freeze(
        (
          database
            .prepare("SELECT payload FROM phase8_node_maintenance ORDER BY key")
            .all() as unknown as readonly Pick<SqliteRow, "payload">[]
        )
          .map((item) => JSON.parse(item.payload) as NodeMaintenanceOperation)
          .filter((item) => item.step !== "completed")
          .slice(0, limit),
      );
    },
    get: (operationId) =>
      get(database, "phase8_node_maintenance", operationId) as
        | NodeMaintenanceOperation
        | undefined,
  };
  return Object.freeze(store);
}

export function openSqliteNodePersistence(path: string): SqliteNodePersistence {
  const database = new DatabaseSync(path);
  migrate(database);
  return Object.freeze({
    close: () => {
      database.close();
    },
    maintenance: createNodeMaintenanceProvider(database),
    nodes: createProvider(database),
  });
}
