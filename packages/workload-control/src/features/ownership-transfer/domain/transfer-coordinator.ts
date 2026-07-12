export type TransferCoordinatorStep =
  | "begun"
  | "gates_closed"
  | "old_effects_drained"
  | "old_authorities_fenced"
  | "epoch_advanced"
  | "new_authorities_installed"
  | "old_credentials_disabled"
  | "ownership_completed"
  | "gates_reopened"
  | "aborted";

export interface OwnershipTransferCoordinator {
  readonly operationId: string;
  readonly namespaceId: string;
  readonly targetWriterId: string;
  readonly targetWriterRelease: string;
  readonly authorityIds: readonly string[];
  readonly step: TransferCoordinatorStep;
  readonly ownershipVersion: number;
  readonly gateRevision: number;
  readonly mutationFence: MutationFence;
  readonly evidenceDigests: Readonly<Record<string, string>>;
  readonly version: number;
}

const steps: readonly TransferCoordinatorStep[] = Object.freeze([
  "begun",
  "gates_closed",
  "old_effects_drained",
  "old_authorities_fenced",
  "epoch_advanced",
  "new_authorities_installed",
  "old_credentials_disabled",
  "ownership_completed",
  "gates_reopened",
]);

export function createOwnershipTransferCoordinator(
  input: Omit<
    OwnershipTransferCoordinator,
    "step" | "evidenceDigests" | "version"
  >,
): OwnershipTransferCoordinator {
  return Object.freeze({
    ...input,
    authorityIds: Object.freeze([...new Set(input.authorityIds)].sort()),
    evidenceDigests: Object.freeze({}),
    step: "begun",
    version: 1,
  });
}

export function advanceOwnershipTransferCoordinator(
  coordinator: OwnershipTransferCoordinator,
  step: TransferCoordinatorStep,
  evidenceDigest: string,
  ownershipVersion = coordinator.ownershipVersion,
  gateRevision = coordinator.gateRevision,
  mutationFence = coordinator.mutationFence,
): OwnershipTransferCoordinator {
  if (coordinator.step === step) {
    if (coordinator.evidenceDigests[step] !== evidenceDigest) {
      throw new Error("ownership_transfer_step_conflict");
    }
    return coordinator;
  }
  if (step === "aborted") {
    if (steps.indexOf(coordinator.step) >= steps.indexOf("epoch_advanced")) {
      throw new Error("post_cas_transfer_cannot_abort");
    }
  } else if (steps.indexOf(step) !== steps.indexOf(coordinator.step) + 1) {
    throw new Error("ownership_transfer_step_out_of_order");
  }
  return Object.freeze({
    ...coordinator,
    evidenceDigests: Object.freeze({
      ...coordinator.evidenceDigests,
      [step]: evidenceDigest,
    }),
    gateRevision,
    mutationFence,
    ownershipVersion,
    step,
    version: coordinator.version + 1,
  });
}

export function nextOwnershipTransferStep(
  coordinator: OwnershipTransferCoordinator,
): TransferCoordinatorStep | undefined {
  if (["aborted", "gates_reopened"].includes(coordinator.step))
    return undefined;
  return steps[steps.indexOf(coordinator.step) + 1];
}
import type { MutationFence } from "@workload-funnel/kernel";
