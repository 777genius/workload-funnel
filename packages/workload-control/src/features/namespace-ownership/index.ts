export {
  NamespaceOwnershipConflictError,
  abortOwnershipTransfer,
  acknowledgeOwnershipAuthority,
  advanceWriterEpoch,
  beginOwnershipTransfer,
  completeOwnershipTransfer,
  initializeNamespaceOwnership,
  type AuthorityInstallAcknowledgement,
  type NamespaceOwnership,
  type NamespaceOwnershipTransfer,
  type OwnershipTransferState,
} from "./domain/namespace-ownership.js";
export type { NamespaceOwnershipStore } from "./application/contracts/namespace-ownership-store.js";
export {
  createNamespaceOwnershipService,
  type NamespaceOwnershipService,
} from "./application/namespace-ownership-service.js";
