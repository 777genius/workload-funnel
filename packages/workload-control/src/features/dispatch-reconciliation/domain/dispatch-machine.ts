import type { Dispatch, DispatchEvidence } from "./dispatch.js";

const transitions: Readonly<
  Record<Dispatch["observed"], readonly Dispatch["observed"][]>
> = Object.freeze({
  pending: Object.freeze<Dispatch["observed"][]>(["submitting", "suppressed"]),
  submitting: Object.freeze<Dispatch["observed"][]>([
    "accepted",
    "starting",
    "running",
    "terminal",
    "unknown",
  ]),
  accepted: Object.freeze<Dispatch["observed"][]>([
    "starting",
    "running",
    "terminal",
    "unknown",
  ]),
  starting: Object.freeze<Dispatch["observed"][]>([
    "running",
    "terminal",
    "unknown",
  ]),
  running: Object.freeze<Dispatch["observed"][]>(["terminal", "unknown"]),
  unknown: Object.freeze<Dispatch["observed"][]>([
    "accepted",
    "starting",
    "running",
    "terminal",
    "absent",
    "reconciliation_required",
  ]),
  absent: Object.freeze<Dispatch["observed"][]>(["submitting", "suppressed"]),
  reconciliation_required: Object.freeze<Dispatch["observed"][]>([]),
  suppressed: Object.freeze<Dispatch["observed"][]>([]),
  terminal: Object.freeze<Dispatch["observed"][]>([]),
});

const evidenceOrder: Readonly<Record<DispatchEvidence["kind"], number>> =
  Object.freeze({
    execution_terminal: 1,
    node_process: 2,
    adapter_lookup: 3,
    scheduler_event: 4,
    submit_receipt: 5,
    absence_proof: 6,
    exhausted: 7,
  });

export class InvalidDispatchTransitionError extends Error {
  public constructor() {
    super("invalid_dispatch_transition");
    this.name = "InvalidDispatchTransitionError";
  }
}

export function transitionDispatch(
  dispatch: Dispatch,
  observed: Dispatch["observed"],
): Dispatch {
  if (!transitions[dispatch.observed].includes(observed)) {
    throw new InvalidDispatchTransitionError();
  }
  return Object.freeze({
    ...dispatch,
    observed,
    version: dispatch.version + 1,
  });
}

export function reconcileUnknownDispatch(
  dispatch: Dispatch,
  evidence: readonly DispatchEvidence[],
): Dispatch {
  if (dispatch.observed !== "unknown") {
    throw new InvalidDispatchTransitionError();
  }
  const positions = new Map<string, DispatchEvidence>();
  for (const item of evidence) {
    const key = `${item.source}:${String(item.sourceEpoch)}:${String(item.sourceSequence)}`;
    const prior = positions.get(key);
    if (prior !== undefined && prior.digest !== item.digest) {
      return Object.freeze({
        ...dispatch,
        lastEvidence: item,
        observed: "reconciliation_required",
        version: dispatch.version + 1,
      });
    }
    positions.set(key, item);
  }
  const selected = [...evidence]
    .filter((item) => item.complete)
    .sort((left, right) => {
      const priority = evidenceOrder[left.kind] - evidenceOrder[right.kind];
      if (priority !== 0) return priority;
      if (left.sourceEpoch !== right.sourceEpoch) {
        return right.sourceEpoch - left.sourceEpoch;
      }
      return right.sourceSequence - left.sourceSequence;
    })[0];
  if (selected === undefined) {
    return Object.freeze({
      ...dispatch,
      observed: "reconciliation_required",
      version: dispatch.version + 1,
    });
  }
  return Object.freeze({
    ...dispatch,
    lastEvidence: selected,
    observed: selected.observed,
    version: dispatch.version + 1,
  });
}
