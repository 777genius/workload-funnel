import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createAuditHistoryTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "audit-history",
    finalizesRank160: false,
    ownerStoreCount: 1,
    supportedModes: Object.freeze(["append"] as const),
  });
}
