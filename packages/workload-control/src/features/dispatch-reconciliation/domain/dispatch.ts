import type { MutationFence } from "@workload-funnel/kernel";

export interface Dispatch {
  readonly dispatchId: string;
  readonly allocationId: string;
  readonly executionGeneration: string;
  readonly adapter: string;
  readonly adapterContractVersion: number;
  readonly operationId: string;
  readonly desired: "submit" | "cancel" | "suppressed";
  readonly observed:
    | "pending"
    | "submitting"
    | "accepted"
    | "starting"
    | "running"
    | "terminal"
    | "unknown"
    | "absent"
    | "reconciliation_required"
    | "suppressed";
  readonly lastEvidence?: DispatchEvidence;
  readonly mutationFence: MutationFence;
  readonly version: number;
}

export type DispatchEvidenceKind =
  | "execution_terminal"
  | "node_process"
  | "adapter_lookup"
  | "scheduler_event"
  | "submit_receipt"
  | "absence_proof"
  | "exhausted";

export interface DispatchEvidence {
  readonly kind: DispatchEvidenceKind;
  readonly source: string;
  readonly sourceEpoch: number;
  readonly sourceSequence: number;
  readonly digest: string;
  readonly complete: boolean;
  readonly observed:
    | "accepted"
    | "starting"
    | "running"
    | "terminal"
    | "absent"
    | "reconciliation_required";
}

export interface DispatchMapping {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly adapterReference: string;
  readonly fingerprint: string;
}

export interface DispatchReceipt {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly disposition: "accepted" | "suppressed" | "cancel_requested";
}
