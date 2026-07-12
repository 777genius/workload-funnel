import type { AcceptanceDurabilityReceipt } from "../../domain/durability.js";

export interface WitnessRecord {
  readonly operationId: string;
  readonly clusterIncarnation: string;
  readonly acceptanceSequence: number;
  readonly commitReference: string;
  readonly digest: string;
}

export interface ExternalAcceptanceWitness {
  appendOrLookupExact(
    pending: AcceptanceDurabilityReceipt,
  ): Readonly<
    | { outcome: "confirmed"; record: WitnessRecord }
    | { outcome: "unavailable" | "unknown" }
    | { outcome: "conflict"; record: WitnessRecord }
  >;
}
