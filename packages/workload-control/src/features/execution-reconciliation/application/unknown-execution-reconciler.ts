import type { Execution } from "../domain/execution.js";

export interface UnknownExecutionEvidence {
  readonly inventoryState:
    | "active"
    | "failed"
    | "inactive"
    | "absent"
    | "unknown";
  readonly invocationIdentityMatches: boolean;
  readonly journalAvailable: boolean;
  readonly launcherWalState:
    | "none"
    | "redeemed"
    | "systemd_call_issued"
    | "started_or_unknown";
  readonly spoolTerminalState?: "exited" | "stopped";
  readonly spoolExecutionGeneration?: string;
}

export interface UnknownExecutionDecision {
  readonly nextState:
    | "running"
    | "exited"
    | "stopped"
    | "lost"
    | "unknown"
    | "reconciliation_required";
  readonly replacementAllowed: boolean;
  readonly result: "converged" | "absence_proven" | "ambiguous" | "cordon";
}

export function reconcileUnknownExecution(
  execution: Execution,
  evidence: UnknownExecutionEvidence,
): UnknownExecutionDecision {
  if (
    evidence.spoolTerminalState !== undefined &&
    evidence.spoolExecutionGeneration === execution.executionGeneration
  ) {
    return {
      nextState: evidence.spoolTerminalState,
      replacementAllowed: true,
      result: "converged",
    };
  }
  if (evidence.inventoryState === "active") {
    return evidence.invocationIdentityMatches
      ? {
          nextState: "running",
          replacementAllowed: false,
          result: "converged",
        }
      : {
          nextState: "reconciliation_required",
          replacementAllowed: false,
          result: "cordon",
        };
  }
  if (
    evidence.launcherWalState === "redeemed" &&
    evidence.inventoryState === "absent" &&
    evidence.journalAvailable
  ) {
    return {
      nextState: "lost",
      replacementAllowed: true,
      result: "absence_proven",
    };
  }
  if (
    evidence.launcherWalState === "none" ||
    (evidence.inventoryState === "inactive" &&
      !evidence.invocationIdentityMatches)
  ) {
    return {
      nextState: "reconciliation_required",
      replacementAllowed: false,
      result: "cordon",
    };
  }
  return {
    nextState: "unknown",
    replacementAllowed: false,
    result: "ambiguous",
  };
}
