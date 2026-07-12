import type { ExternalAcceptanceWitness } from "./contracts/external-witness.js";
import {
  confirmAcceptanceWitness,
  quarantineAcceptanceWitness,
  type AcceptanceDurabilityReceipt,
} from "../domain/durability.js";

export function reconcileAcceptanceWitness(
  pending: AcceptanceDurabilityReceipt,
  witness: ExternalAcceptanceWitness,
): AcceptanceDurabilityReceipt {
  if (pending.state === "witness_confirmed") return pending;
  const outcome = witness.appendOrLookupExact(pending);
  if (outcome.outcome === "conflict")
    return quarantineAcceptanceWitness(pending);
  if (outcome.outcome !== "confirmed") return pending;
  const record = outcome.record;
  if (
    record.operationId !== pending.operationId ||
    record.clusterIncarnation !== pending.clusterIncarnation ||
    record.acceptanceSequence !== pending.acceptanceSequence ||
    record.commitReference !== pending.commitReference
  )
    return quarantineAcceptanceWitness(pending);
  return confirmAcceptanceWitness(pending, record.digest);
}
