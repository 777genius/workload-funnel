export interface Dispatch {
  readonly dispatchId: string;
  readonly allocationId: string;
  readonly executionGeneration: string;
  readonly adapter: "dispatcher-local";
  readonly operationId: string;
  readonly desired: "submit" | "cancel" | "suppressed";
  readonly observed:
    | "pending"
    | "accepted"
    | "running"
    | "terminal"
    | "suppressed";
  readonly version: number;
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
