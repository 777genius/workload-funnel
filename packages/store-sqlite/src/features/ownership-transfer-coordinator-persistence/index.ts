import type {
  ControlFailoverStore,
  ControlServiceFailoverOperation,
  CrashResumableOwnershipTransferStore,
  OwnershipTransferCoordinator,
} from "@workload-funnel/workload-control/ownership-transfer";

export function createInMemorySqliteOwnershipTransferCoordinatorStoreTestFake(
  rows: Map<string, OwnershipTransferCoordinator>,
): CrashResumableOwnershipTransferStore {
  return Object.freeze({
    create(coordinator: OwnershipTransferCoordinator) {
      const prior = rows.get(coordinator.operationId);
      if (prior !== undefined) {
        if (
          prior.namespaceId !== coordinator.namespaceId ||
          prior.targetWriterId !== coordinator.targetWriterId
        )
          throw new Error("ownership_transfer_create_conflict");
        return prior;
      }
      rows.set(coordinator.operationId, coordinator);
      return coordinator;
    },
    get: (operationId: string) => rows.get(operationId),
    save(expectedVersion: number, coordinator: OwnershipTransferCoordinator) {
      const prior = rows.get(coordinator.operationId);
      if (
        prior?.version !== expectedVersion ||
        coordinator.version !== expectedVersion + 1
      ) {
        throw new Error("ownership_transfer_version_conflict");
      }
      rows.set(coordinator.operationId, coordinator);
      return coordinator;
    },
    discoverIncomplete(cursor: string | undefined, limit: number) {
      return Object.freeze(
        [...rows.values()]
          .filter((item) => !["gates_reopened", "aborted"].includes(item.step))
          .filter((item) => cursor === undefined || item.operationId > cursor)
          .sort((left, right) =>
            left.operationId.localeCompare(right.operationId),
          )
          .slice(0, limit),
      );
    },
  });
}

export interface OpenSqliteControlFailoverStore {
  readonly store: ControlFailoverStore;
  close(): void;
}

interface FailoverRow {
  readonly version: number;
  readonly payload: string;
}

function migrateControlFailover(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS phase8_control_failover (
      operation_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0),
      phase TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
  `);
}

function getControlFailover(
  database: DatabaseSync,
  operationId: string,
): ControlServiceFailoverOperation | undefined {
  const row = database
    .prepare(
      "SELECT version, payload FROM phase8_control_failover WHERE operation_id = ?",
    )
    .get(operationId) as FailoverRow | undefined;
  return row === undefined
    ? undefined
    : (JSON.parse(row.payload) as ControlServiceFailoverOperation);
}

export function createSqliteControlFailoverStore(
  database: DatabaseSync,
): ControlFailoverStore {
  migrateControlFailover(database);
  const store: ControlFailoverStore = {
    compareAndSet(expectedVersion, next, claim, now) {
      if (
        next.version !== expectedVersion + 1 ||
        claim.operationId !== next.operationId ||
        claim.leaseUntil <= now
      )
        throw new Error("sqlite_control_failover_conflict");
      const changed = database
        .prepare(
          "UPDATE phase8_control_failover SET version = ?, phase = ?, payload = ? WHERE operation_id = ? AND version = ?",
        )
        .run(
          next.version,
          next.phase,
          JSON.stringify(next),
          next.operationId,
          expectedVersion,
        ).changes;
      if (changed !== 1) throw new Error("sqlite_control_failover_conflict");
      return next;
    },
    create(operation) {
      const inserted = database
        .prepare(
          "INSERT INTO phase8_control_failover (operation_id, version, phase, payload) VALUES (?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING",
        )
        .run(
          operation.operationId,
          operation.version,
          operation.phase,
          JSON.stringify(operation),
        ).changes;
      if (inserted === 1) return operation;
      const current = getControlFailover(database, operation.operationId);
      if (
        current === undefined ||
        JSON.stringify(current) !== JSON.stringify(operation)
      )
        throw new Error("sqlite_control_failover_create_conflict");
      return current;
    },
    discoverIncomplete(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("invalid_control_failover_limit");
      return Object.freeze(
        (
          database
            .prepare(
              "SELECT payload FROM phase8_control_failover WHERE phase <> 'completed' ORDER BY operation_id LIMIT ?",
            )
            .all(limit) as unknown as readonly Pick<FailoverRow, "payload">[]
        ).map(
          (item) => JSON.parse(item.payload) as ControlServiceFailoverOperation,
        ),
      );
    },
    get: (operationId) => getControlFailover(database, operationId),
  };
  return Object.freeze(store);
}

export function openSqliteControlFailoverStore(
  path: string,
): OpenSqliteControlFailoverStore {
  const database = new DatabaseSync(path);
  return Object.freeze({
    close: () => {
      database.close();
    },
    store: createSqliteControlFailoverStore(database),
  });
}
import { DatabaseSync } from "node:sqlite";
