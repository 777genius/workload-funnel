export type OperationGate =
  | "accept"
  | "dispatch"
  | "start"
  | "cancel"
  | "result_finalize";

export interface OperationGateSet {
  readonly namespaceId: string;
  readonly revision: number;
  readonly open: ReadonlySet<OperationGate>;
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
      "dispatch",
      "start",
      "cancel",
      "result_finalize",
    ]),
  });
}

export function closeOperationGates(
  current: OperationGateSet,
  expectedRevision: number,
  gates: readonly OperationGate[],
): OperationGateSet {
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

export function assertGateOpen(
  gates: OperationGateSet,
  gate: OperationGate,
): void {
  if (!gates.open.has(gate)) throw new ClosedOperationGateError(gate);
}
