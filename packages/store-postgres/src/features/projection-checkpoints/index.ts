import type {
  ProjectionCheckpointStore,
  StatusProjection,
} from "@workload-funnel/workload-control/control-event-delivery";

export function createPostgresProjectionStore(
  projections: Map<string, StatusProjection>,
): ProjectionCheckpointStore {
  return Object.freeze({
    get: (runId: string) => projections.get(runId),
    project(projection: StatusProjection) {
      const prior = projections.get(projection.runId);
      if (prior !== undefined && prior.watermark > projection.watermark) {
        throw new Error("Projection watermark cannot move backward");
      }
      projections.set(projection.runId, projection);
    },
  });
}
