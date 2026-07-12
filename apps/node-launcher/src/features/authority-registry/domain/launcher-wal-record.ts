import type { MutationFence } from "@workload-funnel/kernel";
import type { LauncherAuthoritySnapshot } from "./authority-snapshot.js";

export type LauncherStartState =
  | "redeemed"
  | "systemd_call_issued"
  | "started_or_unknown";

export interface AuthorityInstalledWalRecord {
  readonly kind: "authority_installed";
  readonly operationId: string;
  readonly snapshot: LauncherAuthoritySnapshot;
}

export interface StartWalRecord {
  readonly attemptId: string;
  readonly authorityWalSequence: number;
  readonly clusterIncarnation: string;
  readonly executionDeadlineMs: number;
  readonly executionGeneration: string;
  readonly issuerKeyId: string;
  readonly kind: "start_state";
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly nodeBootEpoch: number;
  readonly nodeBootId: string;
  readonly nodeId: string;
  readonly nonce: string;
  readonly operationId: string;
  readonly partitionPolicy:
    | "continue_until_deadline"
    | "executor_fenced"
    | "terminate_after_grace";
  readonly state: LauncherStartState;
  readonly ticketDigest: string;
  readonly unitName: string;
  readonly invocationId?: string;
  readonly observedState?: "started" | "unknown";
}

export interface BreakGlassWalRecord {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly kind: "break_glass_stop";
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly nodeBootEpoch: number;
  readonly nodeBootId: string;
  readonly nodeId: string;
  readonly operationId: string;
  readonly reason: string;
  readonly result: "issued" | "stopped_or_unknown";
  readonly unitName: string;
}

export interface ControlPartitionWalRecord {
  readonly attemptId: string;
  readonly disconnectedAtMs: number;
  readonly executionGeneration: string;
  readonly kind: "control_partition";
  readonly mutationFenceFingerprint: string;
  readonly nodeBootEpoch: number;
  readonly nodeBootId: string;
  readonly nodeId: string;
  readonly partitionPolicy:
    | "continue_until_deadline"
    | "executor_fenced"
    | "terminate_after_grace";
  readonly state: "scheduled" | "stop_issued" | "stopped_or_unknown";
  readonly stopAtMs: number;
  readonly unitName: string;
}

export interface EffectWalRecord {
  readonly effect: "process_stop";
  readonly kind: "effect_state";
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly state: "systemd_call_issued" | "applied_or_unknown";
  readonly ticketDigest: string;
  readonly unitName: string;
}

export interface ScopeStateWalRecord {
  readonly effectScopeKey: string;
  readonly installedFingerprint: string;
  readonly kind: "scope_state";
  readonly operationId: string;
  readonly state: "closed" | "open";
}

export type LauncherWalRecord =
  | AuthorityInstalledWalRecord
  | BreakGlassWalRecord
  | ControlPartitionWalRecord
  | EffectWalRecord
  | ScopeStateWalRecord
  | StartWalRecord;

export interface RecoveredLauncherWalRecord {
  readonly checksum: string;
  readonly record: LauncherWalRecord;
  readonly sequence: number;
}
