import type { MutationFence } from "@workload-funnel/kernel";
import type {
  SchedulerAuthorityHighWatermarkRecord,
  MutateHyperQueueRequest,
  SchedulerMutationScope,
  SchedulerScopeCloseAcknowledgement,
  SignedSchedulerFenceInstallAcknowledgement,
  EffectReceiptEvidence,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export type GatewayWalRecord =
  | {
      readonly acknowledgement: SignedSchedulerFenceInstallAcknowledgement;
      readonly authorityHighWatermarks: readonly SchedulerAuthorityHighWatermarkRecord[];
      readonly fence: MutationFence;
      readonly kind: "install";
      readonly mutationFenceFingerprint: string;
      readonly requestFingerprint: string;
    }
  | {
      readonly acknowledgement: SchedulerScopeCloseAcknowledgement;
      readonly kind: "close";
      readonly requestFingerprint: string;
    }
  | {
      readonly installAcknowledgement: SignedSchedulerFenceInstallAcknowledgement;
      readonly kind: "reopen";
      readonly reopenOperationId: string;
      readonly requestFingerprint: string;
    }
  | {
      readonly kind: "cli_intent";
      readonly request: MutateHyperQueueRequest;
      readonly requestFingerprint: string;
    }
  | {
      readonly kind: "effect_receipt";
      readonly receipt: EffectReceiptEvidence;
      readonly requestFingerprint: string;
    }
  | {
      readonly kind: "scope_cordoned";
      readonly reason: string;
      readonly scope: SchedulerMutationScope;
    };

export interface RecoveredGatewayWalRecord {
  readonly checksum: string;
  readonly previousChecksum: string;
  readonly record: GatewayWalRecord;
  readonly schemaVersion: 1;
  readonly sequence: number;
}
