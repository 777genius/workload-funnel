export type ExecutionTerminationClassification =
  | "child_exit_failure"
  | "exit_success"
  | "host_pressure_eviction"
  | "memory_limit_oom"
  | "node_loss"
  | "operator_cancellation"
  | "systemd_timeout"
  | "unknown_observation_loss";

export interface ExecutionTerminationEvidence {
  readonly cancellationStopObserved: boolean;
  readonly cgroupOomKillCountAfter: number;
  readonly cgroupOomKillCountBefore: number;
  readonly execMainCode: "exited" | "killed" | "unknown";
  readonly execMainStatus: number | null;
  readonly managedOomEviction: boolean;
  readonly nodeReachable: boolean;
  readonly observationComplete: boolean;
  readonly operatorCancellationRequested: boolean;
  readonly systemdResult:
    | "exit-code"
    | "oom-kill"
    | "resources"
    | "signal"
    | "success"
    | "timeout"
    | "unknown";
}

export interface ClassifiedExecutionTermination {
  readonly classification: ExecutionTerminationClassification;
  readonly retryEvidence:
    | "ambiguous"
    | "capacity_pressure"
    | "definite_failure"
    | "definite_success"
    | "desired_stop";
}

function validateCounter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid_oom_event_counter");
  }
}

export function classifyExecutionTermination(
  evidence: ExecutionTerminationEvidence,
): ClassifiedExecutionTermination {
  validateCounter(evidence.cgroupOomKillCountBefore);
  validateCounter(evidence.cgroupOomKillCountAfter);
  if (evidence.cgroupOomKillCountAfter < evidence.cgroupOomKillCountBefore) {
    throw new Error("non_monotonic_oom_event_counter");
  }
  if (!evidence.nodeReachable) {
    return Object.freeze({
      classification: "node_loss",
      retryEvidence: "ambiguous",
    });
  }
  if (!evidence.observationComplete || evidence.systemdResult === "unknown") {
    return Object.freeze({
      classification: "unknown_observation_loss",
      retryEvidence: "ambiguous",
    });
  }
  if (
    evidence.systemdResult === "oom-kill" ||
    evidence.cgroupOomKillCountAfter > evidence.cgroupOomKillCountBefore
  ) {
    return Object.freeze({
      classification: "memory_limit_oom",
      retryEvidence: "capacity_pressure",
    });
  }
  if (evidence.managedOomEviction) {
    return Object.freeze({
      classification: "host_pressure_eviction",
      retryEvidence: "capacity_pressure",
    });
  }
  if (evidence.systemdResult === "timeout") {
    return Object.freeze({
      classification: "systemd_timeout",
      retryEvidence: "definite_failure",
    });
  }
  if (
    evidence.systemdResult === "success" &&
    evidence.execMainCode === "exited" &&
    evidence.execMainStatus === 0
  ) {
    return Object.freeze({
      classification: "exit_success",
      retryEvidence: "definite_success",
    });
  }
  if (evidence.cancellationStopObserved) {
    if (!evidence.operatorCancellationRequested) {
      throw new Error("cancellation_stop_without_request");
    }
    return Object.freeze({
      classification: "operator_cancellation",
      retryEvidence: "desired_stop",
    });
  }
  if (
    evidence.operatorCancellationRequested ||
    evidence.systemdResult === "resources"
  ) {
    return Object.freeze({
      classification: "unknown_observation_loss",
      retryEvidence: "ambiguous",
    });
  }
  return Object.freeze({
    classification: "child_exit_failure",
    retryEvidence: "definite_failure",
  });
}
