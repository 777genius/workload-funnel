import type {
  TargetCapacityObservation,
  TargetProviderCapacityInput,
  TargetResultTranslator,
  TargetTerminalInput,
  TargetTerminalObservation,
} from "@workload-funnel/node-execution/process-lifecycle";

function translateCapacity(
  input: TargetProviderCapacityInput,
): TargetCapacityObservation {
  if (!Number.isSafeInteger(input.observedAtMs) || input.observedAtMs < 0) {
    throw new Error("provider_capacity_invalid_observed_time");
  }
  if (
    input.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(input.retryAfterMs) || input.retryAfterMs < 0)
  ) {
    throw new Error("provider_capacity_invalid_retry_after");
  }
  if (input.state === "available") {
    if (
      input.availableSlots === undefined ||
      !Number.isSafeInteger(input.availableSlots) ||
      input.availableSlots < 0
    ) {
      throw new Error("provider_capacity_invalid_available_slots");
    }
    return {
      availableSlots: input.availableSlots,
      classification: "available",
      observedAtMs: input.observedAtMs,
    };
  }
  const classification =
    input.state === "unavailable"
      ? "provider_unavailable"
      : "temporarily_exhausted";
  return {
    availableSlots: 0,
    classification,
    observedAtMs: input.observedAtMs,
    ...(input.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: input.retryAfterMs }),
  };
}

function translateTerminal(
  input: TargetTerminalInput,
): TargetTerminalObservation {
  const raw = input as unknown as Readonly<Record<string, unknown>>;
  const runtimeOutcome = raw["outcome"];
  if (!["succeeded", "failed", "canceled"].includes(runtimeOutcome as string)) {
    return {
      classification: "quarantined",
      reason: "runtime_terminal_outcome_unknown",
    };
  }
  if (!Number.isSafeInteger(input.completedAtMs) || input.completedAtMs < 0) {
    return {
      classification: "quarantined",
      reason: "runtime_terminal_invalid_completion_time",
    };
  }
  if (input.outcome === "succeeded") {
    if (
      raw["exitCode"] !== 0 ||
      !/^[a-f0-9]{64}$/u.test(input.resultDigest) ||
      "failureCode" in input ||
      "cancellationCode" in input
    ) {
      return {
        classification: "quarantined",
        reason: "runtime_terminal_success_contradiction",
      };
    }
    return {
      classification: "succeeded",
      completedAtMs: input.completedAtMs,
      exitCode: 0,
      resultDigest: input.resultDigest,
    };
  }
  if (input.outcome === "failed") {
    if (
      input.failureCode.length === 0 ||
      input.exitCode === 0 ||
      (input.exitCode !== undefined &&
        (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0)) ||
      "resultDigest" in input ||
      "cancellationCode" in input
    ) {
      return {
        classification: "quarantined",
        reason: "runtime_terminal_failure_contradiction",
      };
    }
    return {
      classification: "provider_failure",
      completedAtMs: input.completedAtMs,
      ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
      failureCode: input.failureCode,
    };
  }
  if (
    input.cancellationCode.length === 0 ||
    "exitCode" in input ||
    "failureCode" in input ||
    "resultDigest" in input
  ) {
    return {
      classification: "quarantined",
      reason: "runtime_terminal_cancellation_contradiction",
    };
  }
  return {
    cancellationCode: input.cancellationCode,
    classification: "canceled",
    completedAtMs: input.completedAtMs,
  };
}

export function createProvider(): TargetResultTranslator {
  return Object.freeze({ translateCapacity, translateTerminal });
}
