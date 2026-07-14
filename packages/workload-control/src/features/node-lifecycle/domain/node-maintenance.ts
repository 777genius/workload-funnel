export type NodeMaintenanceKind = "drain" | "reboot";

export type NodeMaintenanceStep =
  | "requested"
  | "cordoned"
  | "drain_requested"
  | "waiting_for_quiescence"
  | "drained"
  | "reboot_requested"
  | "reboot_observed"
  | "reconciliation_required"
  | "completed";

export type NodeExecutionDrainState =
  | "active"
  | "stop_requested"
  | "terminal"
  | "proven_absent"
  | "unknown";

export interface NodeExecutionDrainObservation {
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly allocationId: string;
  readonly nodeBootEpoch: string;
  readonly state: NodeExecutionDrainState;
  readonly observedSequence: number;
  readonly proof?: NodeExecutionDrainProof;
}

export interface NodeExecutionDrainProof {
  readonly proofId: string;
  readonly proofKind: "canonical_terminal" | "signed_absence";
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly allocationId: string;
  readonly nodeBootEpoch: string;
  readonly durableSequence: number;
  readonly evidenceDigest: string;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
  readonly issuedAt: number;
  readonly notAfter: number;
}

export interface NodeExecutionIdentity {
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly allocationId: string;
  readonly nodeBootEpoch: string;
}

export interface NodeExecutionInventoryReceipt {
  readonly receiptId: string;
  readonly nodeId: string;
  readonly nodeBootEpoch: string;
  readonly inventoryRevision: number;
  readonly complete: boolean;
  readonly durable: boolean;
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly evidenceDigest: string;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
  readonly executions: readonly NodeExecutionDrainObservation[];
}

export interface NodeMaintenanceClaim {
  readonly claimantId: string;
  readonly claimFence: number;
  readonly leaseUntil: number;
}

export interface NodeMaintenanceOperation {
  readonly operationId: string;
  readonly nodeId: string;
  readonly kind: NodeMaintenanceKind;
  readonly requestedBy: string;
  readonly reason: string;
  readonly originalBootEpoch: string;
  readonly observedBootEpoch?: string;
  readonly step: NodeMaintenanceStep;
  readonly pendingExecutionIds: readonly string[];
  readonly reconciliationExecutionIds: readonly string[];
  readonly retainedExecutions: readonly NodeExecutionIdentity[];
  readonly resolvedExecutionIds: readonly string[];
  readonly inventoryRevisions: readonly number[];
  readonly evidence: Readonly<Record<string, string>>;
  readonly claim?: NodeMaintenanceClaim;
  readonly version: number;
}

export class NodeMaintenanceError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "NodeMaintenanceError";
  }
}

export function createNodeMaintenanceOperation(
  input: Omit<
    NodeMaintenanceOperation,
    | "step"
    | "pendingExecutionIds"
    | "reconciliationExecutionIds"
    | "retainedExecutions"
    | "resolvedExecutionIds"
    | "inventoryRevisions"
    | "evidence"
    | "version"
  >,
): NodeMaintenanceOperation {
  if (
    !input.operationId ||
    !input.nodeId ||
    !input.requestedBy ||
    !input.reason ||
    !input.originalBootEpoch
  )
    throw new NodeMaintenanceError("invalid_node_maintenance_request");
  return Object.freeze({
    ...input,
    evidence: Object.freeze({}),
    pendingExecutionIds: Object.freeze([]),
    reconciliationExecutionIds: Object.freeze([]),
    retainedExecutions: Object.freeze([]),
    resolvedExecutionIds: Object.freeze([]),
    inventoryRevisions: Object.freeze([]),
    step: "requested",
    version: 1,
  });
}

export function advanceNodeMaintenance(
  current: NodeMaintenanceOperation,
  next: NodeMaintenanceStep,
  input: Readonly<{
    evidenceDigest: string;
    pendingExecutionIds?: readonly string[];
    reconciliationExecutionIds?: readonly string[];
    retainedExecutions?: readonly NodeExecutionIdentity[];
    resolvedExecutionIds?: readonly string[];
    inventoryRevisions?: readonly number[];
    observedBootEpoch?: string;
  }>,
): NodeMaintenanceOperation {
  const allowed: Readonly<
    Record<NodeMaintenanceStep, readonly NodeMaintenanceStep[]>
  > = {
    requested: ["cordoned"],
    cordoned: ["drain_requested"],
    drain_requested: ["waiting_for_quiescence", "drained"],
    waiting_for_quiescence: ["waiting_for_quiescence", "drained"],
    drained: current.kind === "reboot" ? ["reboot_requested"] : ["completed"],
    reboot_requested: ["reboot_observed"],
    reboot_observed: ["reconciliation_required", "completed"],
    reconciliation_required: ["reconciliation_required", "completed"],
    completed: [],
  };
  if (!allowed[current.step].includes(next))
    throw new NodeMaintenanceError("node_maintenance_step_out_of_order");
  if (!input.evidenceDigest)
    throw new NodeMaintenanceError("node_maintenance_evidence_missing");
  const evidenceKey = `${current.step}->${next}`;
  return Object.freeze({
    ...current,
    evidence: Object.freeze({
      ...current.evidence,
      [evidenceKey]: input.evidenceDigest,
    }),
    ...(input.observedBootEpoch === undefined
      ? {}
      : { observedBootEpoch: input.observedBootEpoch }),
    pendingExecutionIds: Object.freeze(
      [
        ...new Set(input.pendingExecutionIds ?? current.pendingExecutionIds),
      ].sort(),
    ),
    reconciliationExecutionIds: Object.freeze(
      [
        ...new Set(
          input.reconciliationExecutionIds ??
            current.reconciliationExecutionIds,
        ),
      ].sort(),
    ),
    retainedExecutions: Object.freeze(
      [...(input.retainedExecutions ?? current.retainedExecutions)].sort(
        (left, right) => left.executionId.localeCompare(right.executionId),
      ),
    ),
    resolvedExecutionIds: Object.freeze(
      [
        ...new Set(input.resolvedExecutionIds ?? current.resolvedExecutionIds),
      ].sort(),
    ),
    inventoryRevisions: Object.freeze(
      [...new Set(input.inventoryRevisions ?? current.inventoryRevisions)].sort(
        (left, right) => left - right,
      ),
    ),
    step: next,
    version: current.version + 1,
  });
}
