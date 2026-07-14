import type {
  ControlFailoverStore,
  ControlServiceFailoverOperation,
  CrashResumableOwnershipTransferStore,
  OwnershipTransferCoordinator,
} from "@workload-funnel/workload-control/ownership-transfer";

export function createInMemoryPostgresOwnershipTransferCoordinatorStoreTestFake(
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

export interface PostgresControlFailoverDriver {
  readonly capabilities: Readonly<{
    backend: string;
    crashSafe: boolean;
    multiWriter: boolean;
    serializableTransactions: boolean;
  }>;
  migrate(statements: readonly string[]): void;
  get(operationId: string): ControlServiceFailoverOperation | undefined;
  insert(operation: ControlServiceFailoverOperation): boolean;
  compareAndSet(
    operationId: string,
    expectedVersion: number,
    operation: ControlServiceFailoverOperation,
  ): boolean;
  listIncomplete(limit: number): readonly ControlServiceFailoverOperation[];
}

export function createPostgresControlFailoverStore(
  driver: PostgresControlFailoverDriver,
): ControlFailoverStore {
  if (
    driver.capabilities.backend !== "postgres" ||
    !driver.capabilities.crashSafe ||
    !driver.capabilities.multiWriter ||
    !driver.capabilities.serializableTransactions
  )
    throw new Error("postgres_control_failover_driver_incapable");
  driver.migrate(
    Object.freeze([
      "CREATE TABLE IF NOT EXISTS phase8_control_failover (operation_id text PRIMARY KEY, version bigint NOT NULL CHECK (version > 0), phase text NOT NULL, payload jsonb NOT NULL)",
    ]),
  );
  const store: ControlFailoverStore = {
    compareAndSet(expectedVersion, next, claim, now) {
      if (
        next.version !== expectedVersion + 1 ||
        claim.operationId !== next.operationId ||
        claim.leaseUntil <= now ||
        !driver.compareAndSet(next.operationId, expectedVersion, next)
      )
        throw new Error("postgres_control_failover_conflict");
      return next;
    },
    create(operation) {
      if (driver.insert(operation)) return operation;
      const current = driver.get(operation.operationId);
      if (
        current === undefined ||
        JSON.stringify(current) !== JSON.stringify(operation)
      )
        throw new Error("postgres_control_failover_create_conflict");
      return current;
    },
    discoverIncomplete(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("invalid_control_failover_limit");
      return Object.freeze([...driver.listIncomplete(limit)]);
    },
    get: (operationId) => driver.get(operationId),
  };
  return Object.freeze(store);
}
