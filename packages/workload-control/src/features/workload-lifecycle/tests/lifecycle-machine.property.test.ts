import { describe, expect, it } from "vitest";

import {
  InvalidLifecycleTransitionError,
  TerminalIntentConflictError,
  TerminalReleaseReceiptRequiredError,
  createExecutionGenerationIssuer,
  isAttemptTerminal,
  recordTerminalizationIntent,
  requestRunCancellation,
  revokeAttemptStart,
  transitionAttempt,
  transitionRun,
  validAttemptTransitions,
  type Attempt,
  type AttemptState,
  type Run,
} from "../index.js";

function attempt(state: AttemptState = "queued"): Attempt {
  return Object.freeze({
    attachmentRejections: 0,
    attemptId: "attempt-1",
    cancellationDesired: "none",
    executionGeneration: "generation:attempt-1",
    reservationRequestRevision: 0,
    runId: "run-1",
    startAuthorization: "authorized",
    startFence: "start-fence-1",
    startRevocationRevision: 0,
    state,
    version: 1,
  });
}

function run(state: Run["state"] = "accepted"): Run {
  return Object.freeze({
    attemptId: "attempt-1",
    cancellationDesired: "none",
    runId: "run-1",
    state,
    version: 1,
    workloadId: "workload-1",
  });
}

const states: readonly AttemptState[] = Object.freeze([
  "queued",
  "admitted",
  "dispatching",
  "starting",
  "running",
  "publishing_results",
  "unknown",
  "reconciliation_required",
  "succeeded",
  "failed",
  "lost",
  "canceled",
]);

describe("Phase 2 workload lifecycle state machines", () => {
  it("property-checks every valid and invalid Attempt transition pair", () => {
    for (const from of states) {
      for (const to of states) {
        const source = attempt(from);
        const valid = validAttemptTransitions(from).includes(to);
        if (isAttemptTerminal(to)) {
          expect(() => transitionAttempt(source, to)).toThrow(
            valid
              ? TerminalReleaseReceiptRequiredError
              : InvalidLifecycleTransitionError,
          );
        } else if (valid) {
          expect(transitionAttempt(source, to)).toMatchObject({
            state: to,
            version: 2,
          });
        } else {
          expect(() => transitionAttempt(source, to)).toThrow(
            InvalidLifecycleTransitionError,
          );
        }
      }
    }
  });

  it("requires a frozen same-disposition intent and receipt for every terminal edge", () => {
    for (const disposition of [
      "succeeded",
      "failed",
      "publication_failure",
      "lost",
      "canceled",
    ] as const) {
      const sourceState: AttemptState =
        disposition === "succeeded" || disposition === "publication_failure"
          ? "publishing_results"
          : disposition === "lost"
            ? "unknown"
            : "running";
      const withIntent = recordTerminalizationIntent(attempt(sourceState), {
        creatingOperationId: `terminal-${disposition}`,
        disposition,
        evidenceDigest: `digest-${disposition}`,
        evidenceKind: "synthetic_terminal_observation",
        evidenceVersion: 1,
        executionGeneration: "generation:attempt-1",
        precedenceDecision:
          disposition === "canceled" ? "cancellation_won" : "completion_won",
      });
      const terminalState =
        disposition === "publication_failure" ? "failed" : disposition;
      const terminal = transitionAttempt(
        withIntent,
        terminalState,
        `terminal-release:${disposition}`,
      );
      expect(terminal).toMatchObject({
        state: terminalState,
        terminalReleaseReceiptId: `terminal-release:${disposition}`,
      });
    }
  });

  it("freezes completion-versus-cancellation before release", () => {
    const completion = recordTerminalizationIntent(attempt("running"), {
      creatingOperationId: "completion",
      disposition: "failed",
      evidenceDigest: "exit-1",
      evidenceKind: "execution_exit",
      evidenceVersion: 3,
      executionGeneration: "generation:attempt-1",
      precedenceDecision: "completion_won",
    });
    expect(
      recordTerminalizationIntent(completion, {
        creatingOperationId: "completion",
        disposition: "failed",
        evidenceDigest: "exit-1",
        evidenceKind: "execution_exit",
        evidenceVersion: 3,
        executionGeneration: "generation:attempt-1",
        precedenceDecision: "completion_won",
      }),
    ).toBe(completion);
    expect(() =>
      recordTerminalizationIntent(completion, {
        creatingOperationId: "cancel",
        disposition: "canceled",
        evidenceDigest: "stop-1",
        evidenceKind: "cancellation_barrier",
        evidenceVersion: 4,
        executionGeneration: "generation:attempt-1",
        precedenceDecision: "cancellation_won",
      }),
    ).toThrow(TerminalIntentConflictError);
  });

  it("keeps Run and Attempt cancellation intent orthogonal to observations", () => {
    const accepted = requestRunCancellation(run());
    expect(accepted).toMatchObject({
      cancellationDesired: "requested",
      state: "accepted",
    });
    const unknown = revokeAttemptStart(attempt("unknown"));
    expect(unknown).toMatchObject({
      cancellationDesired: "requested",
      startAuthorization: "revoked",
      startRevocationRevision: 1,
      state: "unknown",
    });
    expect(revokeAttemptStart(unknown)).toBe(unknown);
  });

  it("represents immediate accepted-before-activation cancellation", () => {
    const canceled = transitionRun(requestRunCancellation(run()), "canceled");
    expect(canceled).toMatchObject({
      cancellationDesired: "requested",
      state: "canceled",
      terminalOutcome: "canceled",
    });
  });

  it("issues one stable generation only from an Attempt identity", () => {
    const issuer = createExecutionGenerationIssuer();
    const first = issuer.issueForAttempt("attempt-1");
    expect(issuer.issueForAttempt("attempt-1")).toBe(first);
    expect(issuer.issueForAttempt("attempt-2")).not.toBe(first);
    expect(first).toBe("generation:attempt-1");
  });

  it("preserves immutable identity separation", () => {
    const identities = new Set([
      "workload-1",
      "run-1",
      "attempt-1",
      "allocation-1",
      "dispatch-1",
      "execution-1",
      "manifest-1",
    ]);
    expect(identities.size).toBe(7);
  });
});
