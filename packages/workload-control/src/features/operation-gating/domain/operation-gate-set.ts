export type OperationGate =
  | "accept"
  | "acceptance"
  | "admission_reservation"
  | "dispatch"
  | "dispatch_submit"
  | "start"
  | "process_start"
  | "automatic_retry"
  | "cancel"
  | "result_finalize"
  | "result_archive"
  | "result_delete";

export interface OperationGateSet {
  readonly namespaceId: string;
  readonly revision: number;
  readonly open: ReadonlySet<OperationGate>;
}

export interface OperationGateMutationCommand {
  readonly authorizationGate: OperationGate;
  readonly current: OperationGateSet;
  readonly expectedRevision: number;
  readonly gates: readonly OperationGate[];
  readonly mutationFence: MutationFence;
}

export class ClosedOperationGateError extends Error {
  public constructor(gate: OperationGate) {
    super(`Operation gate is closed: ${gate}`);
    this.name = "ClosedOperationGateError";
  }
}

export function createClosedGateSet(namespaceId: string): OperationGateSet {
  return Object.freeze({
    namespaceId,
    open: new Set<OperationGate>(),
    revision: 0,
  });
}

export function openSyntheticTestGates(
  current: OperationGateSet,
  expectedRevision: number,
): OperationGateSet {
  if (!current.namespaceId.startsWith("test://phase1/")) {
    throw new Error(
      "Operation gates may only open in the Phase 1 test namespace",
    );
  }
  if (current.revision !== expectedRevision)
    throw new Error("Stale operation gate revision");
  return Object.freeze({
    namespaceId: current.namespaceId,
    revision: current.revision + 1,
    open: new Set<OperationGate>([
      "accept",
      "acceptance",
      "admission_reservation",
      "dispatch",
      "dispatch_submit",
      "start",
      "process_start",
      "automatic_retry",
      "cancel",
      "result_finalize",
      "result_archive",
      "result_delete",
    ]),
  });
}

export function closeOperationGates(
  command: OperationGateMutationCommand,
): OperationGateSet {
  const { current, expectedRevision, gates, mutationFence } = command;
  assertMutationFenceGateOpen(
    current,
    mutationFence,
    command.authorizationGate,
  );
  if (current.revision !== expectedRevision)
    throw new Error("Stale operation gate revision");
  const open = new Set(current.open);
  for (const gate of gates) open.delete(gate);
  return Object.freeze({
    namespaceId: current.namespaceId,
    open,
    revision: current.revision + 1,
  });
}

export function assertMutationFenceGateOpen(
  gates: OperationGateSet,
  mutationFence: MutationFence,
  requiredGate: OperationGate,
): void {
  validateMutationFence(mutationFence);
  if (
    mutationFence.namespaceId !== gates.namespaceId ||
    mutationFence.operationGateRevision !== gates.revision ||
    mutationFence.requiredGate !== requiredGate
  ) {
    throw new Error("mutation_fence_gate_mismatch");
  }
  assertGateOpen(gates, requiredGate);
}

export function assertGateOpen(
  gates: OperationGateSet,
  gate: OperationGate,
): void {
  if (!gates.open.has(gate)) throw new ClosedOperationGateError(gate);
}
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
