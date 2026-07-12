export type DurabilityProfile =
  | "single_node_durable"
  | "synchronous_ha"
  | "externally_witnessed";

export interface AcceptanceDurabilityReceipt {
  readonly operationId: string;
  readonly clusterIncarnation: string;
  readonly durabilityProfile: DurabilityProfile;
  readonly acceptanceSequence: number;
  readonly commitReference: string;
  readonly state:
    | "committed"
    | "witness_pending"
    | "witness_confirmed"
    | "witness_quarantined";
  readonly witnessDigest?: string;
}

export interface RestoreSafetyState {
  readonly clusterIncarnation: string;
  readonly recoveredHighWatermark: number;
  readonly externalHighWatermark?: number;
  readonly executionReconciliationComplete: boolean;
  readonly gapReconciliationComplete: boolean;
  readonly state: "ready" | "restore_quarantine";
}

export function createAcceptanceDurabilityReceipt(
  operationId: string,
  clusterIncarnation: string,
  profile: DurabilityProfile,
  acceptanceSequence: number,
  commitReference: string,
): AcceptanceDurabilityReceipt {
  return Object.freeze({
    acceptanceSequence,
    clusterIncarnation,
    commitReference,
    durabilityProfile: profile,
    operationId,
    state: profile === "externally_witnessed" ? "witness_pending" : "committed",
  });
}

export function confirmAcceptanceWitness(
  receipt: AcceptanceDurabilityReceipt,
  witnessDigest: string,
): AcceptanceDurabilityReceipt {
  if (receipt.durabilityProfile !== "externally_witnessed") {
    throw new Error("witness_not_required");
  }
  if (receipt.state === "witness_confirmed") {
    if (receipt.witnessDigest !== witnessDigest)
      throw new Error("witness_conflict");
    return receipt;
  }
  if (receipt.state !== "witness_pending")
    throw new Error("witness_quarantined");
  return Object.freeze({
    ...receipt,
    state: "witness_confirmed",
    witnessDigest,
  });
}

export function quarantineAcceptanceWitness(
  receipt: AcceptanceDurabilityReceipt,
): AcceptanceDurabilityReceipt {
  if (receipt.state !== "witness_pending") return receipt;
  return Object.freeze({ ...receipt, state: "witness_quarantined" });
}

export function evaluateRestoreSafety(
  input: Omit<RestoreSafetyState, "state">,
): RestoreSafetyState {
  const possibleGap =
    input.externalHighWatermark !== undefined &&
    input.recoveredHighWatermark < input.externalHighWatermark;
  const ready =
    !possibleGap &&
    input.executionReconciliationComplete &&
    input.gapReconciliationComplete;
  return Object.freeze({
    ...input,
    state: ready ? "ready" : "restore_quarantine",
  });
}

export function assertRestoreAdmissionOpen(state: RestoreSafetyState): void {
  if (state.state !== "ready") throw new Error("restore_quarantine");
}
