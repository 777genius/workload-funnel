export const canonicalParticipantIds = [
  "tenant-admission",
  "allocation-leasing",
  "workload-lifecycle",
  "control-event-delivery",
  "capacity-management",
  "result-management",
  "audit-history",
] as const;

export type CanonicalParticipantId = (typeof canonicalParticipantIds)[number];

export const canonicalBundleIds = [
  "accept-workload-v1",
  "confirm-acceptance-witness-v1",
  "reserve-allocation-v1",
  "attach-allocation-v1",
  "reject-allocation-attachment-v1",
  "record-attempt-terminal-intent-v1",
  "release-allocation-v1",
  "apply-attempt-terminal-v2",
  "finalize-result-v1",
  "tombstone-result-v1",
] as const;

export type CanonicalBundleId = (typeof canonicalBundleIds)[number];

export type CanonicalParticipantMode =
  | "accept_charge"
  | "queued_to_active"
  | "rollback_charge"
  | "terminal_release"
  | "verify_release"
  | "reserve"
  | "verify_reservation"
  | "rollback_unattached"
  | "verify_uniqueness_only"
  | "release_and_finalize_rank_160"
  | "verify_only"
  | "accept"
  | "confirm_witness"
  | "verify_queued"
  | "attach"
  | "record_rejection"
  | "record_terminal_intent"
  | "verify_terminal_intent"
  | "terminalize"
  | "debt_inbox_outbox"
  | "reserve_acceptance"
  | "reserve_staging"
  | "rollback_staging"
  | "terminal_disposition"
  | "verify_disposition"
  | "staging_to_result"
  | "release_result_bytes"
  | "finalize_manifest"
  | "tombstone_manifest"
  | "append";

export interface CanonicalTransactionParticipant {
  readonly id: CanonicalParticipantId;
  readonly supportedModes: readonly CanonicalParticipantMode[];
  readonly finalizesRank160: boolean;
  readonly ownerStoreCount: number;
}

export interface CanonicalBundleDefinition {
  readonly bundleId: CanonicalBundleId;
  readonly ranks: readonly number[];
  readonly modes: Readonly<
    Partial<Record<CanonicalParticipantId, CanonicalParticipantMode>>
  >;
}

export interface CanonicalTransactionTrace {
  readonly backend: "postgres" | "sqlite";
  readonly bundleId: CanonicalBundleId;
  readonly operationId: string;
  readonly events: readonly string[];
}

export interface CanonicalBundleReceipt {
  readonly bundleId: CanonicalBundleId;
  readonly operationId: string;
  readonly activeParticipants: readonly CanonicalParticipantId[];
  readonly ranks: readonly number[];
  readonly trace: CanonicalTransactionTrace;
}

export class InvalidParticipantSetError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidParticipantSetError";
  }
}
