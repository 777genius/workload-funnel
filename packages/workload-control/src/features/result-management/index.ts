export {
  IncompleteResultManifestError,
  type ResultEntry,
  type ResultManifest,
} from "./domain/result-manifest.js";
export type { ResultStore } from "./application/contracts/result-store.js";
export {
  createResultManagementService,
  type ResultManagementService,
} from "./application/result-service.js";
export { createResultManagementTransactionParticipant } from "./application/transaction-participant.js";
