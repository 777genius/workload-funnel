import type {
  NamespaceOwnership,
  NamespaceOwnershipStore,
} from "@workload-funnel/workload-control/namespace-ownership";

export interface SqliteNamespaceOwnershipState {
  readonly rows: Map<string, NamespaceOwnership>;
}

export function createSqliteNamespaceOwnershipStore(
  state: SqliteNamespaceOwnershipState,
): NamespaceOwnershipStore {
  return Object.freeze({
    create(initial: NamespaceOwnership) {
      const prior = state.rows.get(initial.namespaceId);
      if (prior !== undefined) return prior;
      state.rows.set(initial.namespaceId, initial);
      return initial;
    },
    get: (namespaceId: string) => state.rows.get(namespaceId),
    compareAndSet(
      namespaceId: string,
      expectedVersion: number,
      next: NamespaceOwnership,
    ) {
      const prior = state.rows.get(namespaceId);
      if (
        prior?.version !== expectedVersion ||
        next.version !== expectedVersion + 1
      ) {
        throw new Error("sqlite_namespace_ownership_conflict");
      }
      state.rows.set(namespaceId, next);
      return next;
    },
  });
}
