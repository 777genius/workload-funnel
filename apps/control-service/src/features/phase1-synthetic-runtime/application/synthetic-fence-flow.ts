import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import {
  createSyntheticArtifactFinalizeCommand,
  createSyntheticResultFinalizeCommand,
} from "@workload-funnel/workload-control/result-management";
import {
  prepareSyntheticMutationFence,
  type Attempt,
  type WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type {
  DurableState,
  SyntheticArtifactWriter,
} from "./synthetic-state.js";

export function allocationForAttempt(
  state: DurableState,
  attempt: Attempt,
): Allocation | undefined {
  return attempt.allocationId === undefined
    ? undefined
    : state.allocations.get(attempt.allocationId);
}

export function publishSyntheticResultFiles(
  state: DurableState,
  artifacts: SyntheticArtifactWriter,
  attemptId: string,
  files: WorkloadStatus["workload"]["spec"]["resultFiles"],
) {
  const attempt = state.attemptById.get(attemptId);
  if (attempt === undefined) throw new Error("Attempt does not exist");
  const allocation = allocationForAttempt(state, attempt);
  return files.map((file) =>
    Object.freeze({
      ...file,
      location: `file://${artifacts.write(
        createSyntheticArtifactFinalizeCommand({
          ...(allocation === undefined
            ? {}
            : {
                allocationId: allocation.allocationId,
                ownerFence: allocation.ownerFence,
              }),
          attemptId,
          content: file.content,
          executionGeneration: attempt.executionGeneration,
          gateRevision: state.gateSet.revision,
          namespaceId: state.gateSet.namespaceId,
          openGates: state.gateSet.open,
          path: file.path,
        }),
      )}`,
    }),
  );
}

export function prepareSyntheticEffectFence(
  state: DurableState,
  attempt: Attempt,
  desiredEffect:
    | "dispatch_submit"
    | "dispatch_cancel"
    | "process_start"
    | "process_stop"
    | "artifact_finalize",
  requiredGate:
    | "dispatch_submit"
    | "cancel"
    | "process_start"
    | "result_finalize",
  effectScopeKey: string,
  expectedDesiredVersion: number,
  allocationOverride?: Allocation,
) {
  const allocation = allocationOverride ?? allocationForAttempt(state, attempt);
  return prepareSyntheticMutationFence({
    ...(allocation === undefined
      ? {}
      : {
          allocation: {
            allocationId: allocation.allocationId,
            ownerFence: allocation.ownerFence,
          },
        }),
    attempt,
    desiredEffect,
    effectScopeKey,
    expectedDesiredVersion,
    gateRevision: state.gateSet.revision,
    namespaceId: state.gateSet.namespaceId,
    requiredGate,
    supersessionKey: effectScopeKey,
  });
}

export function prepareSyntheticResultFinalizeCommand(
  state: DurableState,
  attempt: Attempt,
  files: readonly (WorkloadStatus["workload"]["spec"]["resultFiles"][number] & {
    readonly location?: string;
  })[],
) {
  const allocation = allocationForAttempt(state, attempt);
  return createSyntheticResultFinalizeCommand({
    ...(allocation === undefined
      ? {}
      : {
          allocationId: allocation.allocationId,
          ownerFence: allocation.ownerFence,
        }),
    attemptId: attempt.attemptId,
    executionGeneration: attempt.executionGeneration,
    ...(attempt.executionId === undefined
      ? {}
      : { executionId: attempt.executionId }),
    files,
    gateRevision: state.gateSet.revision,
    namespaceId: state.gateSet.namespaceId,
    openGates: state.gateSet.open,
  });
}
