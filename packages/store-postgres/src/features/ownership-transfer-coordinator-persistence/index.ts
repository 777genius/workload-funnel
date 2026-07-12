import type {
  CrashResumableOwnershipTransferStore,
  OwnershipTransferCoordinator,
} from "@workload-funnel/workload-control/ownership-transfer";

export function createPostgresOwnershipTransferCoordinatorStore(
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
