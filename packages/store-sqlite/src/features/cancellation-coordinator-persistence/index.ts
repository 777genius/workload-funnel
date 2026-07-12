import type {
  CancellationSaga,
  CancellationSagaStore,
} from "@workload-funnel/workload-control/cancellation";

export function createSqliteCancellationSagaStore(
  rows: Map<string, CancellationSaga>,
): CancellationSagaStore {
  return Object.freeze({
    get: (operationId: string) => rows.get(operationId),
    save(saga: CancellationSaga) {
      const prior = rows.get(saga.operationId);
      if (prior !== undefined && saga.version < prior.version) {
        throw new Error("stale_cancellation_saga");
      }
      rows.set(saga.operationId, saga);
    },
  });
}
