import type {
  NodeMaintenanceOperation,
  NodeMaintenanceStore,
  NodeSnapshot,
  NodeStore,
} from "@workload-funnel/workload-control/node-lifecycle";

export {
  createAsyncPostgresNodeObservationStore,
  type AsyncPostgresNodeObservationStore,
  type DurableNodeObservation,
  type PostgresNodeExecutor,
} from "./async-postgres-node-store.js";

export interface PostgresDurableRow {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
}

/**
 * Synchronous unit-of-work port supplied by the service's Postgres adapter.
 * Implementations MUST use one SERIALIZABLE transaction for each callback and
 * MUST map create/CAS to INSERT/UPDATE predicates in Postgres, never a cache.
 */
export interface PostgresPhase8NodeDriver {
  readonly capabilities: Readonly<{
    backend: string;
    crashSafe: boolean;
    multiWriter: boolean;
    serializableTransactions: boolean;
  }>;
  migrate(statements: readonly string[]): void;
  transaction<T>(callback: () => T): T;
  get(
    table: "phase8_node" | "phase8_node_maintenance",
    key: string,
  ): PostgresDurableRow | undefined;
  insert(
    table: "phase8_node" | "phase8_node_maintenance",
    row: PostgresDurableRow,
  ): boolean;
  compareAndSet(
    table: "phase8_node" | "phase8_node_maintenance",
    expectedVersion: number,
    row: PostgresDurableRow,
  ): boolean;
  list(table: "phase8_node_maintenance"): readonly PostgresDurableRow[];
}

export interface PostgresNodePersistence {
  readonly nodes: NodeStore;
  readonly maintenance: NodeMaintenanceStore;
}

const migrations = Object.freeze([
  "CREATE TABLE IF NOT EXISTS phase8_node (key text PRIMARY KEY, version bigint NOT NULL CHECK (version > 0), payload jsonb NOT NULL)",
  "CREATE TABLE IF NOT EXISTS phase8_node_maintenance (key text PRIMARY KEY, version bigint NOT NULL CHECK (version > 0), payload jsonb NOT NULL)",
]);

function parse(row: PostgresDurableRow | undefined): unknown {
  return row === undefined ? undefined : (JSON.parse(row.payload) as unknown);
}

function row(key: string, version: number, value: unknown): PostgresDurableRow {
  return Object.freeze({ key, payload: JSON.stringify(value), version });
}

function assertDriver(driver: PostgresPhase8NodeDriver): void {
  if (
    driver.capabilities.backend !== "postgres" ||
    !driver.capabilities.crashSafe ||
    !driver.capabilities.multiWriter ||
    !driver.capabilities.serializableTransactions
  )
    throw new Error("postgres_phase8_node_driver_incapable");
}

export function createPostgresNodePersistence(
  driver: PostgresPhase8NodeDriver,
): PostgresNodePersistence {
  assertDriver(driver);
  driver.migrate(migrations);

  const nodes: NodeStore = {
    compareAndSet(nodeId, expectedVersion, next) {
      if (next.nodeId !== nodeId || next.version !== expectedVersion + 1)
        throw new Error("postgres_node_version_conflict");
      return driver.transaction(() => {
        if (
          !driver.compareAndSet(
            "phase8_node",
            expectedVersion,
            row(nodeId, next.version, next),
          )
        )
          throw new Error("postgres_node_version_conflict");
        return next;
      });
    },
    create(node) {
      return driver.transaction(() => {
        if (driver.insert("phase8_node", row(node.nodeId, node.version, node)))
          return node;
        const current = parse(driver.get("phase8_node", node.nodeId)) as
          | NodeSnapshot
          | undefined;
        if (
          current === undefined ||
          JSON.stringify(current) !== JSON.stringify(node)
        )
          throw new Error("postgres_node_identity_conflict");
        return current;
      });
    },
    get: (nodeId) =>
      parse(driver.get("phase8_node", nodeId)) as NodeSnapshot | undefined,
  };

  const maintenance: NodeMaintenanceStore = {
    claim(operationId, claimantId, expectedClaimFence, now, leaseUntil) {
      return driver.transaction(() => {
        const current = parse(
          driver.get("phase8_node_maintenance", operationId),
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
          !driver.compareAndSet(
            "phase8_node_maintenance",
            current.version,
            row(operationId, claimed.version, claimed),
          )
        )
          throw new Error("node_maintenance_claim_conflict");
        return claimed;
      });
    },
    compareAndSet(expectedVersion, next, claim, now) {
      if (next.version !== expectedVersion + 1 || claim.leaseUntil <= now)
        throw new Error("stale_node_maintenance_claim");
      return driver.transaction(() => {
        const current = parse(
          driver.get("phase8_node_maintenance", next.operationId),
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
          !driver.compareAndSet(
            "phase8_node_maintenance",
            expectedVersion,
            row(next.operationId, persisted.version, persisted),
          )
        )
          throw new Error("stale_node_maintenance_claim");
        return persisted;
      });
    },
    create(operation) {
      return driver.transaction(() => {
        if (
          driver.insert(
            "phase8_node_maintenance",
            row(operation.operationId, operation.version, operation),
          )
        )
          return operation;
        const current = parse(
          driver.get("phase8_node_maintenance", operation.operationId),
        ) as NodeMaintenanceOperation | undefined;
        if (
          current?.nodeId !== operation.nodeId ||
          current.kind !== operation.kind ||
          current.requestedBy !== operation.requestedBy ||
          current.reason !== operation.reason ||
          current.originalBootEpoch !== operation.originalBootEpoch
        )
          throw new Error("postgres_node_maintenance_operation_conflict");
        return current;
      });
    },
    discoverIncomplete(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("invalid_node_maintenance_limit");
      return Object.freeze(
        driver
          .list("phase8_node_maintenance")
          .map((item) => parse(item) as NodeMaintenanceOperation | undefined)
          .filter(
            (item): item is NodeMaintenanceOperation =>
              item !== undefined && item.step !== "completed",
          )
          .sort((left, right) =>
            left.operationId.localeCompare(right.operationId),
          )
          .slice(0, limit),
      );
    },
    get: (operationId) =>
      parse(driver.get("phase8_node_maintenance", operationId)) as
        | NodeMaintenanceOperation
        | undefined,
  };

  return Object.freeze({
    maintenance: Object.freeze(maintenance),
    nodes: Object.freeze(nodes),
  });
}

export function createProvider(driver: PostgresPhase8NodeDriver): NodeStore {
  return createPostgresNodePersistence(driver).nodes;
}

export function createNodeMaintenanceProvider(
  driver: PostgresPhase8NodeDriver,
): NodeMaintenanceStore {
  return createPostgresNodePersistence(driver).maintenance;
}
