import type {
  TargetEventPage,
  TargetSnapshotPage,
} from "@workload-funnel/node-execution/process-lifecycle";

export interface RuntimeReconciliationClient {
  readEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<TargetEventPage>;
  readSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<TargetSnapshotPage>;
}
