import type {
  TargetMutationBoundary,
  TargetOperationReceipt,
} from "@workload-funnel/node-execution/process-lifecycle";

export interface DurableRuntimeOperation {
  readonly boundary: TargetMutationBoundary;
  readonly idempotencyKey: string;
  readonly intentFingerprint: string;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly receipt?: TargetOperationReceipt;
  readonly runtimeTargetId: string;
  readonly state: "pending" | "recorded" | "unknown";
}

export interface RuntimeOperationStore {
  find(idempotencyKey: string): Promise<DurableRuntimeOperation | undefined>;
  reserve(operation: DurableRuntimeOperation): Promise<DurableRuntimeOperation>;
  save(
    operation: DurableRuntimeOperation,
    receipt: TargetOperationReceipt,
  ): Promise<DurableRuntimeOperation>;
  saveUnknown(
    operation: DurableRuntimeOperation,
  ): Promise<DurableRuntimeOperation>;
}
