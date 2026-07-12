import type {
  Attempt,
  AttemptState,
  Run,
  TerminalOutcome,
  TerminalizationIntent,
} from "./workload-records.js";

const attemptTransitions: Readonly<
  Record<AttemptState, readonly AttemptState[]>
> = {
  queued: Object.freeze<AttemptState[]>(["admitted", "canceled"]),
  admitted: Object.freeze<AttemptState[]>(["dispatching", "canceled"]),
  dispatching: Object.freeze<AttemptState[]>([
    "starting",
    "publishing_results",
    "failed",
    "unknown",
    "canceled",
  ]),
  starting: Object.freeze<AttemptState[]>([
    "running",
    "publishing_results",
    "failed",
    "unknown",
    "canceled",
  ]),
  running: Object.freeze<AttemptState[]>([
    "publishing_results",
    "failed",
    "unknown",
    "canceled",
  ]),
  publishing_results: Object.freeze<AttemptState[]>([
    "succeeded",
    "failed",
    "unknown",
    "canceled",
  ]),
  unknown: Object.freeze<AttemptState[]>([
    "starting",
    "running",
    "publishing_results",
    "failed",
    "canceled",
    "reconciliation_required",
    "lost",
  ]),
  reconciliation_required: Object.freeze<AttemptState[]>([]),
  succeeded: Object.freeze<AttemptState[]>([]),
  failed: Object.freeze<AttemptState[]>([]),
  lost: Object.freeze<AttemptState[]>([]),
  canceled: Object.freeze<AttemptState[]>([]),
};

const terminalStates = new Set<AttemptState>([
  "succeeded",
  "failed",
  "lost",
  "canceled",
]);

export class InvalidLifecycleTransitionError extends Error {
  public constructor(aggregate: "Attempt" | "Run", from: string, to: string) {
    super(`${aggregate} cannot transition from ${from} to ${to}`);
    this.name = "InvalidLifecycleTransitionError";
  }
}

export class TerminalReleaseReceiptRequiredError extends Error {
  public constructor() {
    super(
      "Attempt terminalization requires its matching owner release receipt",
    );
    this.name = "TerminalReleaseReceiptRequiredError";
  }
}

export class TerminalIntentConflictError extends Error {
  public constructor() {
    super("terminal_intent_conflict");
    this.name = "TerminalIntentConflictError";
  }
}

export function validAttemptTransitions(
  state: AttemptState,
): readonly AttemptState[] {
  return attemptTransitions[state];
}

export function isAttemptTerminal(state: AttemptState): boolean {
  return terminalStates.has(state);
}

export function transitionAttempt(
  attempt: Attempt,
  next: AttemptState,
  releaseReceiptId?: string,
): Attempt {
  if (!attemptTransitions[attempt.state].includes(next)) {
    throw new InvalidLifecycleTransitionError("Attempt", attempt.state, next);
  }
  if (terminalStates.has(next)) {
    if (
      (attempt.terminalizationIntent?.disposition === "publication_failure"
        ? next !== "failed"
        : attempt.terminalizationIntent?.disposition !== next) ||
      releaseReceiptId === undefined
    ) {
      throw new TerminalReleaseReceiptRequiredError();
    }
  }
  return Object.freeze({
    ...attempt,
    state: next,
    ...(releaseReceiptId === undefined
      ? {}
      : { terminalReleaseReceiptId: releaseReceiptId }),
    version: attempt.version + 1,
  });
}

export function requestRunCancellation(run: Run): Run {
  if (run.cancellationDesired === "requested") return run;
  return Object.freeze({
    ...run,
    cancellationDesired: "requested",
    version: run.version + 1,
  });
}

export function revokeAttemptStart(attempt: Attempt): Attempt {
  if (attempt.startAuthorization === "revoked") return attempt;
  return Object.freeze({
    ...attempt,
    cancellationDesired: "requested",
    startAuthorization: "revoked",
    startRevocationRevision: attempt.startRevocationRevision + 1,
    version: attempt.version + 1,
  });
}

function sameIntent(
  left: TerminalizationIntent,
  right: TerminalizationIntent,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function recordTerminalizationIntent(
  attempt: Attempt,
  candidate: Omit<TerminalizationIntent, "terminalizationIntentId">,
): Attempt {
  const intent = Object.freeze({
    ...candidate,
    terminalizationIntentId: `terminal-intent:${candidate.creatingOperationId}`,
  });
  if (attempt.terminalizationIntent !== undefined) {
    if (!sameIntent(attempt.terminalizationIntent, intent)) {
      throw new TerminalIntentConflictError();
    }
    return attempt;
  }
  if (candidate.executionGeneration !== attempt.executionGeneration) {
    throw new TerminalIntentConflictError();
  }
  return Object.freeze({
    ...attempt,
    terminalizationIntent: intent,
    version: attempt.version + 1,
  });
}

const runTransitions: Readonly<Record<Run["state"], readonly Run["state"][]>> =
  Object.freeze({
    accepted: Object.freeze<Run["state"][]>([
      "active",
      "succeeded",
      "failed",
      "canceled",
    ]),
    active: Object.freeze<Run["state"][]>(["succeeded", "failed", "canceled"]),
    succeeded: Object.freeze<Run["state"][]>([]),
    failed: Object.freeze<Run["state"][]>([]),
    canceled: Object.freeze<Run["state"][]>([]),
  });

export function transitionRun(run: Run, next: Run["state"]): Run {
  if (!runTransitions[run.state].includes(next)) {
    throw new InvalidLifecycleTransitionError("Run", run.state, next);
  }
  const terminalOutcome =
    next === "active" ? undefined : (next as TerminalOutcome);
  return Object.freeze({
    ...run,
    state: next,
    ...(terminalOutcome === undefined ? {} : { terminalOutcome }),
    version: run.version + 1,
  });
}
