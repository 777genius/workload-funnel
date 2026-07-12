export {
  IncompleteResultManifestError,
  type ResultEntry,
  type ResultManifest,
  type ArtifactOperation,
  type ResultTombstone,
} from "./domain/result-manifest.js";
export {
  InvalidRetentionTransitionError,
  markArtifactOperationUnknown,
  markRetentionDue,
  prepareArtifactOperation,
  reconcileArtifactOperation,
  tombstoneResult,
} from "./domain/result-manifest.js";
export {
  decideResultCompletion,
  type ResultCompletionReceipt,
} from "./application/result-process-manager.js";
export type { ResultStore } from "./application/contracts/result-store.js";
export {
  createSyntheticArtifactFinalizeCommand,
  createSyntheticResultFinalizeCommand,
  createResultManagementService,
  type ArtifactFinalizeCommand,
  type ArtifactFinalizeAuthority,
  type ResultFinalizeCommand,
  type ResultManagementService,
} from "./application/result-service.js";
export { createResultManagementTransactionParticipant } from "./application/transaction-participant.js";
