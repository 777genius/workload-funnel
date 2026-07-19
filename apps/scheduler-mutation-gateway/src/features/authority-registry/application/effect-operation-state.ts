import type {
  AuthorizedHyperQueueMutation,
  EffectReceiptEvidence,
  HyperQueueDispatchMapping,
  MutateHyperQueueRequest,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export interface OperationState {
  readonly canonicalJobName?: string;
  readonly intentRegistrySequence: number;
  mapping?: HyperQueueDispatchMapping;
  readonly request: MutateHyperQueueRequest;
  readonly requestFingerprint: string;
  receipt?: EffectReceiptEvidence;
}

export type PrepareGatewayMutation =
  | {
      readonly authorization: AuthorizedHyperQueueMutation;
      readonly kind: "authorized";
      readonly requestFingerprint: string;
    }
  | { readonly kind: "receipt"; readonly receipt: EffectReceiptEvidence };
