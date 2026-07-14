export {
  InvalidWorkloadError,
  type AcceptanceReceipt,
  type AttemptTerminalDisposition,
  type Attempt,
  type AttemptState,
  type CancellationReceipt,
  type CancellationDesired,
  type OperationStatus,
  type ResourceRequest,
  type Run,
  type SyntheticResultFile,
  type TerminalOutcome,
  type TerminalizationIntent,
  type Workload,
  type WorkloadSpec,
  type WorkloadStatus,
} from "./domain/workload-records.js";
export {
  InvalidLifecycleTransitionError,
  TerminalIntentConflictError,
  TerminalReleaseReceiptRequiredError,
  isAttemptTerminal,
  recordTerminalizationIntent,
  requestRunCancellation,
  revokeAttemptStart,
  transitionAttempt,
  transitionRun,
  validAttemptTransitions,
} from "./domain/lifecycle-machine.js";
export {
  createExecutionGenerationIssuer,
  type ExecutionGenerationIssuer,
} from "./domain/execution-generation.js";
export type {
  AcceptanceInput,
  LifecyclePersistenceFactoryInput,
  LifecyclePersistenceHooks,
  LifecyclePersistenceState,
  LifecycleRepository,
} from "./application/contracts/lifecycle-repository.js";
export {
  createWorkloadLifecycleService,
  type AuthenticatedPrincipal,
  type SubmitCommand,
  type WorkloadLifecycleService,
} from "./application/workload-service.js";
export { createWorkloadLifecycleTransactionParticipant } from "./application/transaction-participant.js";
export {
  prepareSyntheticMutationFence,
  type SyntheticMutationFencePreparationCommand,
} from "./application/mutation-fence-preparation.js";
export {
  assertRestoreAdmissionOpen,
  confirmAcceptanceWitness,
  createAcceptanceDurabilityReceipt,
  evaluateRestoreSafety,
  quarantineAcceptanceWitness,
  type AcceptanceDurabilityReceipt,
  type DurabilityProfile,
  type RestoreSafetyState,
} from "./domain/durability.js";
export type {
  ExternalAcceptanceWitness,
  WitnessRecord,
} from "./application/contracts/external-witness.js";
export { reconcileAcceptanceWitness } from "./application/witness-process.js";
export {
  advanceDisasterRecovery,
  advancePersistedDisasterRecovery,
  assertDisasterRecoveryAdmissionOpen,
  beginDisasterRecovery,
  beginPersistedDisasterRecovery,
  canonicalHistoryDigest,
  disasterRecoveryEffectEvidenceDigest,
  createWorkloadBackupManifest,
  DisasterRecoveryError,
  signDisasterRecoveryEffectReceipt,
  type CanonicalHistoryKind,
  type CanonicalHistoryRecord,
  type DisasterRecoveryOperation,
  type DisasterRecoveryEffectReceipt,
  type DisasterRecoveryEffectPayload,
  type DisasterRecoveryEffectTrust,
  type DisasterRecoveryStore,
  type DisasterRecoveryStep,
  type WorkloadBackupManifest,
} from "./application/disaster-recovery.js";
export {
  disasterRecoveryCompletedEffectEvidenceDigest,
  signDisasterRecoveryCompletedEffectReceipt,
  verifyDisasterRecoveryCompletedEffectReceipt,
  type DisasterRecoveryCompletedEffectKind,
  type DisasterRecoveryCompletedEffectReceipt,
  type DisasterRecoveryCompletedEffectTrust,
} from "./application/disaster-recovery-effect-evidence.js";
