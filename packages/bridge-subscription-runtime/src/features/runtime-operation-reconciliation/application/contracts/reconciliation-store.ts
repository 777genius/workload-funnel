import type { TargetOperationObservation } from "@workload-funnel/node-execution/process-lifecycle";

export interface RuntimeObservationPage {
  readonly entries: readonly TargetOperationObservation[];
  readonly nextCursor?: string;
}

export interface RuntimeReconciliationStore {
  applyEventBatch(
    events: readonly TargetOperationObservation[],
    checkpoint: string | undefined,
  ): Promise<void>;
  checkpoint(): Promise<string | undefined>;
  list(
    cursor: string | undefined,
    limit: number,
  ): Promise<RuntimeObservationPage>;
  saveSnapshotObservation(
    observation: TargetOperationObservation,
  ): Promise<void>;
}
