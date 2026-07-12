import type {
  CanonicalBundleDefinition,
  CanonicalBundleId,
  CanonicalParticipantId,
  CanonicalParticipantMode,
} from "./canonical-bundle.js";

type ModeVector = Readonly<
  Partial<Record<CanonicalParticipantId, CanonicalParticipantMode>>
>;

function supported(
  ...modes: readonly CanonicalParticipantMode[]
): readonly CanonicalParticipantMode[] {
  return Object.freeze([...modes]);
}

function definition(
  bundleId: CanonicalBundleId,
  ranks: readonly number[],
  modes: ModeVector,
): CanonicalBundleDefinition {
  return Object.freeze({
    bundleId,
    modes: Object.freeze({ ...modes }),
    ranks: Object.freeze([...ranks]),
  });
}

export const canonicalBundleMatrix: Readonly<
  Record<CanonicalBundleId, CanonicalBundleDefinition>
> = Object.freeze({
  "accept-workload-v1": definition(
    "accept-workload-v1",
    [10, 20, 30, 60, 110, 120, 130, 140, 150],
    {
      "tenant-admission": "accept_charge",
      "workload-lifecycle": "accept",
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "reserve_acceptance",
      "audit-history": "append",
    },
  ),
  "confirm-acceptance-witness-v1": definition(
    "confirm-acceptance-witness-v1",
    [10, 60, 110, 130, 140, 150],
    {
      "workload-lifecycle": "confirm_witness",
      "control-event-delivery": "debt_inbox_outbox",
      "audit-history": "append",
    },
  ),
  "reserve-allocation-v1": definition(
    "reserve-allocation-v1",
    [20, 30, 40, 50, 60, 110, 120, 130, 140, 150],
    {
      "tenant-admission": "queued_to_active",
      "allocation-leasing": "reserve",
      "workload-lifecycle": "verify_queued",
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "reserve_staging",
      "audit-history": "append",
    },
  ),
  "attach-allocation-v1": definition(
    "attach-allocation-v1",
    [40, 50, 60, 110, 130, 140, 150],
    {
      "allocation-leasing": "verify_reservation",
      "workload-lifecycle": "attach",
      "control-event-delivery": "debt_inbox_outbox",
      "audit-history": "append",
    },
  ),
  "reject-allocation-attachment-v1": definition(
    "reject-allocation-attachment-v1",
    [20, 30, 40, 50, 60, 110, 120, 130, 140, 150],
    {
      "tenant-admission": "rollback_charge",
      "allocation-leasing": "rollback_unattached",
      "workload-lifecycle": "record_rejection",
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "rollback_staging",
      "audit-history": "append",
    },
  ),
  "record-attempt-terminal-intent-v1": definition(
    "record-attempt-terminal-intent-v1",
    [40, 50, 60, 110, 130, 140, 150],
    {
      "allocation-leasing": "verify_uniqueness_only",
      "workload-lifecycle": "record_terminal_intent",
      "control-event-delivery": "debt_inbox_outbox",
      "audit-history": "append",
    },
  ),
  "release-allocation-v1": definition(
    "release-allocation-v1",
    [20, 30, 40, 50, 60, 110, 120, 130, 140, 150, 160],
    {
      "tenant-admission": "terminal_release",
      "allocation-leasing": "release_and_finalize_rank_160",
      "workload-lifecycle": "verify_terminal_intent",
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "terminal_disposition",
      "audit-history": "append",
    },
  ),
  "apply-attempt-terminal-v2": definition(
    "apply-attempt-terminal-v2",
    [20, 40, 50, 60, 110, 120, 130, 140, 150],
    {
      "tenant-admission": "verify_release",
      "allocation-leasing": "verify_only",
      "workload-lifecycle": "terminalize",
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "verify_disposition",
      "audit-history": "append",
    },
  ),
  "finalize-result-v1": definition(
    "finalize-result-v1",
    [90, 100, 110, 120, 130, 140, 150],
    {
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "staging_to_result",
      "result-management": "finalize_manifest",
      "audit-history": "append",
    },
  ),
  "tombstone-result-v1": definition(
    "tombstone-result-v1",
    [90, 100, 110, 120, 130, 140, 150],
    {
      "control-event-delivery": "debt_inbox_outbox",
      "capacity-management": "release_result_bytes",
      "result-management": "tombstone_manifest",
      "audit-history": "append",
    },
  ),
});

export const participantSupportedModes: Readonly<
  Record<CanonicalParticipantId, readonly CanonicalParticipantMode[]>
> = Object.freeze({
  "tenant-admission": supported(
    "accept_charge",
    "queued_to_active",
    "rollback_charge",
    "terminal_release",
    "verify_release",
  ),
  "allocation-leasing": supported(
    "reserve",
    "verify_reservation",
    "rollback_unattached",
    "verify_uniqueness_only",
    "release_and_finalize_rank_160",
    "verify_only",
  ),
  "workload-lifecycle": supported(
    "accept",
    "confirm_witness",
    "verify_queued",
    "attach",
    "record_rejection",
    "record_terminal_intent",
    "verify_terminal_intent",
    "terminalize",
  ),
  "control-event-delivery": supported("debt_inbox_outbox"),
  "capacity-management": supported(
    "reserve_acceptance",
    "reserve_staging",
    "rollback_staging",
    "terminal_disposition",
    "verify_disposition",
    "staging_to_result",
    "release_result_bytes",
  ),
  "result-management": supported("finalize_manifest", "tombstone_manifest"),
  "audit-history": supported("append"),
});
