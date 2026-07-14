import type {
  Allocation,
  TerminalReleaseReceipt,
} from "@workload-funnel/workload-control/allocation-leasing";
import type {
  Execution,
  ExecutionTerminalReconciliationDecision,
} from "@workload-funnel/workload-control/execution-reconciliation";
import type {
  ResultManifest,
  ResultStagingEvidence,
  ResultVerificationEvidence,
} from "@workload-funnel/workload-control/result-management";
import type {
  Attempt,
  TerminalOutcome,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type { prepareSyntheticEffectFence } from "./synthetic-fence-flow.js";

export interface SyntheticRuntimeContext {
  readonly allocation: Allocation;
  readonly attempt: Attempt;
  readonly execution?: Execution;
  readonly processFence: ReturnType<typeof prepareSyntheticEffectFence>;
}

export interface SyntheticRuntimeTerminalEvidence {
  readonly classification:
    | "unknown"
    | "quarantined"
    | "succeeded"
    | "provider_failure"
    | "canceled";
  readonly expectedOperationId: string;
  readonly observationOperationId: string;
  readonly observationRuntimeOperationId: string;
  readonly receiptMutationFenceFingerprint: string;
  readonly receiptOperationId: string;
  readonly receiptRuntimeOperationId: string;
  readonly runId: string;
}

export interface SyntheticTerminalProgressInput {
  readonly creatingOperationId: string;
  readonly disposition: TerminalOutcome | "publication_failure" | "lost";
  readonly evidenceDigest: string;
  readonly evidenceKind: string;
  readonly runId: string;
}

export interface SyntheticTerminalProgress {
  readonly phase: "intent_recorded" | "released" | "completed";
  readonly release?: TerminalReleaseReceipt;
  readonly status: WorkloadStatus;
}

export interface SyntheticExternalLifecycle {
  applyResultVerification(
    runId: string,
    resultManifestId: string,
    verification: ResultVerificationEvidence,
  ): ResultManifest;
  progressTerminal(
    input: SyntheticTerminalProgressInput,
  ): SyntheticTerminalProgress;
  reconcileRuntimeTerminal(
    evidence: SyntheticRuntimeTerminalEvidence,
  ): ExecutionTerminalReconciliationDecision;
  runtimeContext(runId: string): SyntheticRuntimeContext;
  stageResult(runId: string, evidence: ResultStagingEvidence): ResultManifest;
}
