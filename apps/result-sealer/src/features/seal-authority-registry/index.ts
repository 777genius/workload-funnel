import type { SealAuthorityRegistry } from "./application/seal-authority-registry.js";

export {
  SealAuthorityRegistry,
  SealRegistryError,
  type SealAuthorityInstallAcknowledgement,
  type SealPreparedEvidence,
  type SealRegistryErrorCode,
} from "./application/seal-authority-registry.js";
export {
  SealerWal,
  SealerWalError,
  type SealerCordonReason,
} from "./application/sealer-wal.js";
export type { SealerWalStorage } from "./application/contracts/sealer-wal-storage.js";
export type {
  PinnedFilesystemIdentity,
  RecoveredSealerWalRecord,
  SealerWalRecord,
  SealWalState,
} from "./domain/sealer-wal-record.js";
export {
  FilesystemSealerWalStorage,
  PRODUCTION_RESULT_SEALER_WAL_DIRECTORY,
  type FilesystemSealerWalConfig,
} from "./filesystem.js";

export type SealAuthorityProvider = SealAuthorityRegistry;

export function createProvider(
  registry: SealAuthorityRegistry,
): SealAuthorityProvider {
  return registry;
}
