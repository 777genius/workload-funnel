import type {
  AcceptanceDurabilityReceipt,
  ExternalAcceptanceWitness,
  WitnessRecord,
} from "@workload-funnel/workload-control/workload-lifecycle";

export interface SyntheticExternalWitnessState {
  readonly records: Map<string, WitnessRecord>;
  available: boolean;
  ambiguousNextAppend: boolean;
}

function recordFor(pending: AcceptanceDurabilityReceipt): WitnessRecord {
  return Object.freeze({
    acceptanceSequence: pending.acceptanceSequence,
    clusterIncarnation: pending.clusterIncarnation,
    commitReference: pending.commitReference,
    digest: `synthetic-witness:${pending.clusterIncarnation}:${String(pending.acceptanceSequence)}:${pending.commitReference}`,
    operationId: pending.operationId,
  });
}

export function createSyntheticExternalWitness(
  state: SyntheticExternalWitnessState,
): ExternalAcceptanceWitness {
  return Object.freeze({
    appendOrLookupExact(pending: AcceptanceDurabilityReceipt) {
      if (!state.available) return Object.freeze({ outcome: "unavailable" });
      const expected = recordFor(pending);
      const prior = state.records.get(pending.operationId);
      if (prior !== undefined) {
        return JSON.stringify(prior) === JSON.stringify(expected)
          ? Object.freeze({ outcome: "confirmed", record: prior })
          : Object.freeze({ outcome: "conflict", record: prior });
      }
      state.records.set(pending.operationId, expected);
      if (state.ambiguousNextAppend) {
        state.ambiguousNextAppend = false;
        return Object.freeze({ outcome: "unknown" });
      }
      return Object.freeze({ outcome: "confirmed", record: expected });
    },
  });
}
