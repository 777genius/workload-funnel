import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createResultManagementTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "result-management",
    finalizesRank160: false,
    ownerStoreCount: 4,
    supportedModes: Object.freeze([
      "finalize_manifest",
      "tombstone_manifest",
    ] as const),
  });
}
