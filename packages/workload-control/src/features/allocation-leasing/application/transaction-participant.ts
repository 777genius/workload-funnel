import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createAllocationLeasingTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "allocation-leasing",
    finalizesRank160: true,
    ownerStoreCount: 2,
    supportedModes: Object.freeze([
      "reserve",
      "verify_reservation",
      "rollback_unattached",
      "verify_uniqueness_only",
      "release_and_finalize_rank_160",
      "verify_only",
    ] as const),
  });
}
