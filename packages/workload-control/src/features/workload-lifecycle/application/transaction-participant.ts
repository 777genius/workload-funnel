import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";

export function createWorkloadLifecycleTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "workload-lifecycle",
    finalizesRank160: false,
    ownerStoreCount: 1,
    supportedModes: Object.freeze([
      "accept",
      "confirm_witness",
      "verify_queued",
      "attach",
      "record_rejection",
      "record_terminal_intent",
      "verify_terminal_intent",
      "terminalize",
    ] as const),
  });
}
