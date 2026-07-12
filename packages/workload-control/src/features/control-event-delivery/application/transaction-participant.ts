import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createControlEventDeliveryTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "control-event-delivery",
    finalizesRank160: false,
    ownerStoreCount: 3,
    supportedModes: Object.freeze(["debt_inbox_outbox"] as const),
  });
}
