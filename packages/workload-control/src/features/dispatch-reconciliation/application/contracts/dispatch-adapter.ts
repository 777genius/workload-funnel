import type { MutationFence } from "@workload-funnel/kernel";

export interface DispatchMutationAuthority {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly clusterIncarnation: string;
  readonly clusterIncarnationVersion: number;
  readonly desiredEffect: "dispatch_submit" | "dispatch_cancel";
  readonly effectScopeKey: string;
  readonly executionGeneration: string;
  readonly expectedDesiredVersion: number;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly openGates: ReadonlySet<string>;
  readonly operationGateRevision: number;
  readonly ownerFence: number;
  readonly requiredGate: string;
  readonly startFence?: string;
  readonly startRevocationRevision?: number;
  readonly supersessionKey: string;
}

export interface DispatchSubmissionInput {
  readonly authority: DispatchMutationAuthority;
  readonly dispatchId: string;
  readonly executionGeneration: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
}

export interface DispatchCancellationInput {
  readonly authority: DispatchMutationAuthority;
  readonly dispatchId: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
}

export interface DispatchSubmissionEvidence {
  readonly adapterReference: string;
  readonly fingerprint: string;
}

export interface DispatchSubmitter {
  submit(input: DispatchSubmissionInput): DispatchSubmissionEvidence;
}

export interface DispatchCanceler {
  cancel(input: DispatchCancellationInput): void;
}

export interface DispatchObserver {
  observe(dispatchId: string): "accepted" | "canceled" | "absent";
}

export interface DispatchCapabilityProvider {
  readonly adapter: "dispatcher-local";
  readonly capabilities: readonly ["local_dispatch"];
}
