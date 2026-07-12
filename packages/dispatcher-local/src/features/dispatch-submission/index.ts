import type { DispatchSubmitter } from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  compareMutationFence,
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export interface LocalDispatchFenceHighWatermark {
  readonly desiredEffect: "dispatch_submit" | "dispatch_cancel";
  readonly desiredVersion: number;
  readonly fingerprint: string;
}

export function createLocalDispatchSubmitter(
  effects: Map<string, "accepted" | "canceled">,
  highWatermarks = new Map<string, LocalDispatchFenceHighWatermark>(),
  nowMs: () => number = Date.now,
): DispatchSubmitter {
  const submitter: DispatchSubmitter = {
    submit(input) {
      const mutationFence: MutationFence = input.mutationFence;
      validateMutationFence(mutationFence);
      const fingerprint = fingerprintMutationFence(mutationFence);
      const comparison = compareMutationFence(
        mutationFence,
        input.authority,
        nowMs(),
      );
      if (
        mutationFence.desiredEffect !== "dispatch_submit" ||
        mutationFence.requiredGate !== "dispatch_submit" ||
        mutationFence.clusterIncarnation !== "synthetic-phase1-cluster" ||
        !mutationFence.namespaceId.startsWith("test://phase1/") ||
        mutationFence.effectScopeKey !== `dispatch:${input.dispatchId}` ||
        mutationFence.supersessionKey !== `dispatch:${input.dispatchId}` ||
        mutationFence.executionGeneration !== input.executionGeneration ||
        mutationFence.allocationId !==
          `allocation-${input.dispatchId.slice("dispatch-".length)}` ||
        comparison !== "current"
      ) {
        throw new Error(
          `local_dispatch_submission_fence_mismatch:${comparison}`,
        );
      }
      const priorFence = highWatermarks.get(mutationFence.effectScopeKey);
      if (
        priorFence !== undefined &&
        (priorFence.desiredVersion > mutationFence.expectedDesiredVersion ||
          (priorFence.desiredVersion === mutationFence.expectedDesiredVersion &&
            priorFence.fingerprint !== fingerprint))
      ) {
        throw new Error("local_dispatch_submission_stale_fence");
      }
      const prior = effects.get(input.dispatchId);
      if (prior === "canceled")
        throw new Error("Canceled local dispatch cannot be resubmitted");
      highWatermarks.set(mutationFence.effectScopeKey, {
        desiredEffect: "dispatch_submit",
        desiredVersion: mutationFence.expectedDesiredVersion,
        fingerprint,
      });
      effects.set(input.dispatchId, "accepted");
      return Object.freeze({
        adapterReference: `local://${input.dispatchId}`,
        fingerprint: `local:${input.operationId}:${fingerprint}`,
      });
    },
  };
  return Object.freeze(submitter);
}
