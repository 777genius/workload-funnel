import type { MutationFence } from "@workload-funnel/kernel";
import type {
  SealOutputReceipt,
  SignedSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";

export interface PinnedFilesystemIdentity {
  readonly device: string;
  readonly inode: string;
}

export type SealWalState =
  | "prepared"
  | "seal_call_issued"
  | "sealed_or_unknown"
  | "receipt_persisted";

export type SealerWalRecord =
  | Readonly<{
      kind: "wal_initialized";
      formatVersion: 1;
      ledgerId: string;
    }>
  | Readonly<{
      kind: "authority_installed";
      installOperationId: string;
      authorization: SignedSealOutputRequest;
    }>
  | Readonly<{
      kind: "seal_state";
      operationId: string;
      state: SealWalState;
      tupleFingerprint: string;
      mutationFence: MutationFence;
      mutationFenceFingerprint: string;
      outputParent: PinnedFilesystemIdentity;
      stagingParent: PinnedFilesystemIdentity;
      sourceName: string;
      destinationName: string;
      treeDigest: string;
      receipt?: SealOutputReceipt;
    }>;

export interface RecoveredSealerWalRecord {
  readonly checksum: string;
  readonly previousChecksum: string;
  readonly record: SealerWalRecord;
  readonly sequence: number;
}
