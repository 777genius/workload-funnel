export type ControlPartitionPolicy =
  | "terminate_after_grace"
  | "continue_until_deadline"
  | "executor_fenced";

export type ReplayClass = "replay_safe" | "side_effectful" | "non_replayable";

export interface PartitionExecutorCapabilities {
  readonly externalFenceEnforced: boolean;
}

export interface PartitionPolicyInput {
  readonly capabilities: PartitionExecutorCapabilities;
  readonly disconnectedForMs: number;
  readonly executionDeadlineMs: number;
  readonly graceMs: number;
  readonly nowMs: number;
  readonly policy: ControlPartitionPolicy;
  readonly replayClass: ReplayClass;
}

export interface PartitionDecision {
  readonly acceptNewWork: false;
  readonly action: "continue_existing" | "stop_existing";
  readonly replacementBlocked: true;
  readonly reason:
    | "authority_disconnected"
    | "deadline_reached"
    | "external_fence_missing"
    | "fenced_executor_continuation"
    | "grace_active"
    | "grace_exhausted";
}

export class InvalidPartitionPolicyError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "InvalidPartitionPolicyError";
  }
}

export function validateControlPartitionPolicy(
  policy: ControlPartitionPolicy,
  replayClass: ReplayClass,
  capabilities: PartitionExecutorCapabilities,
): void {
  if (policy === "executor_fenced" && !capabilities.externalFenceEnforced) {
    throw new InvalidPartitionPolicyError("executor_fencing_unavailable");
  }
  if (policy === "continue_until_deadline" && replayClass === "replay_safe") {
    throw new InvalidPartitionPolicyError(
      "continue_policy_requires_ambiguous_replay_protection",
    );
  }
}

export function decideControlPartition(
  input: PartitionPolicyInput,
): PartitionDecision {
  validateControlPartitionPolicy(
    input.policy,
    input.replayClass,
    input.capabilities,
  );
  if (
    !Number.isSafeInteger(input.disconnectedForMs) ||
    input.disconnectedForMs < 0 ||
    !Number.isSafeInteger(input.graceMs) ||
    input.graceMs < 0 ||
    !Number.isSafeInteger(input.nowMs) ||
    !Number.isSafeInteger(input.executionDeadlineMs)
  ) {
    throw new InvalidPartitionPolicyError("invalid_partition_deadline");
  }
  if (input.nowMs >= input.executionDeadlineMs) {
    return {
      acceptNewWork: false,
      action: "stop_existing",
      reason: "deadline_reached",
      replacementBlocked: true,
    };
  }
  if (input.policy === "terminate_after_grace") {
    return input.disconnectedForMs >= input.graceMs
      ? {
          acceptNewWork: false,
          action: "stop_existing",
          reason: "grace_exhausted",
          replacementBlocked: true,
        }
      : {
          acceptNewWork: false,
          action: "continue_existing",
          reason: "grace_active",
          replacementBlocked: true,
        };
  }
  if (input.policy === "executor_fenced") {
    return {
      acceptNewWork: false,
      action: "continue_existing",
      reason: "fenced_executor_continuation",
      replacementBlocked: true,
    };
  }
  return {
    acceptNewWork: false,
    action: "continue_existing",
    reason: "authority_disconnected",
    replacementBlocked: true,
  };
}
