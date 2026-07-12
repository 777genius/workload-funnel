import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createTenantAdmissionTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "tenant-admission",
    finalizesRank160: false,
    ownerStoreCount: 2,
    supportedModes: Object.freeze([
      "accept_charge",
      "queued_to_active",
      "rollback_charge",
      "terminal_release",
      "verify_release",
    ] as const),
  });
}
