import type { AttemptState } from "@workload-funnel/workload-control/workload-lifecycle";

import type { EffectReceiptEvidence } from "./effect-receipt.js";
import { isFinalZeroMutationSupersession } from "./effect-receipt.js";
import type { Execution } from "./execution.js";

const transitions: Readonly<
  Record<Execution["state"], readonly Execution["state"][]>
> = Object.freeze({
  prepared: Object.freeze<Execution["state"][]>([
    "start_requested",
    "superseded",
  ]),
  start_requested: Object.freeze<Execution["state"][]>([
    "starting",
    "superseded",
    "unknown",
  ]),
  starting: Object.freeze<Execution["state"][]>([
    "running",
    "exited",
    "stopped",
    "unknown",
  ]),
  running: Object.freeze<Execution["state"][]>([
    "stop_requested",
    "exited",
    "unknown",
  ]),
  stop_requested: Object.freeze<Execution["state"][]>([
    "stopped",
    "exited",
    "unknown",
  ]),
  unknown: Object.freeze<Execution["state"][]>([
    "running",
    "exited",
    "stopped",
    "lost",
    "reconciliation_required",
  ]),
  exited: Object.freeze<Execution["state"][]>([]),
  stopped: Object.freeze<Execution["state"][]>([]),
  superseded: Object.freeze<Execution["state"][]>([]),
  lost: Object.freeze<Execution["state"][]>([]),
  reconciliation_required: Object.freeze<Execution["state"][]>([]),
});

export class InvalidExecutionTransitionError extends Error {
  public constructor() {
    super("invalid_execution_transition");
    this.name = "InvalidExecutionTransitionError";
  }
}

export function transitionExecution(
  execution: Execution,
  next: Execution["state"],
): Execution {
  if (!transitions[execution.state].includes(next)) {
    throw new InvalidExecutionTransitionError();
  }
  return Object.freeze({
    ...execution,
    observationSequence: execution.observationSequence + 1,
    state: next,
    version: execution.version + 1,
  });
}

export function supersedeExecution(
  execution: Execution,
  receipt: EffectReceiptEvidence,
): Execution {
  if (
    !["prepared", "start_requested"].includes(execution.state) ||
    !isFinalZeroMutationSupersession(receipt)
  ) {
    throw new InvalidExecutionTransitionError();
  }
  return transitionExecution(execution, "superseded");
}

export interface ExecutionTerminalPolicy {
  readonly exitAccepted: boolean;
  readonly cancellationEffectWon: boolean;
  readonly stopClassification?:
    | "cancellation"
    | "safety"
    | "timeout"
    | "pressure"
    | "unexplained";
  readonly lostProofComplete?: boolean;
}

export function mapTerminalExecutionToAttempt(
  currentAttemptState: AttemptState,
  executionState: Execution["state"],
  policy: ExecutionTerminalPolicy,
): AttemptState | undefined {
  if (executionState === "superseded") return undefined;
  if (executionState === "lost") {
    return policy.lostProofComplete === true ? "lost" : "unknown";
  }
  if (executionState === "exited") {
    if (policy.cancellationEffectWon) return "canceled";
    return policy.exitAccepted ? "publishing_results" : "failed";
  }
  if (executionState === "stopped") {
    if (
      policy.cancellationEffectWon &&
      policy.stopClassification === "cancellation"
    )
      return "canceled";
    return policy.stopClassification === "unexplained"
      ? "reconciliation_required"
      : "failed";
  }
  if (executionState === "unknown") return "unknown";
  if (
    executionState === "running" &&
    ["starting", "unknown"].includes(currentAttemptState)
  )
    return "running";
  return undefined;
}
