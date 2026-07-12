export interface DispatchSubmissionInput {
  readonly dispatchId: string;
  readonly operationId: string;
  readonly executionGeneration: string;
}

export interface DispatchSubmissionEvidence {
  readonly adapterReference: string;
  readonly fingerprint: string;
}

export interface DispatchSubmitter {
  submit(input: DispatchSubmissionInput): DispatchSubmissionEvidence;
}

export interface DispatchCanceler {
  cancel(dispatchId: string, operationId: string): void;
}

export interface DispatchObserver {
  observe(dispatchId: string): "accepted" | "canceled" | "absent";
}

export interface DispatchCapabilityProvider {
  readonly adapter: "dispatcher-local";
  readonly capabilities: readonly ["local_dispatch"];
}
