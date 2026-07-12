import type { DispatchCanceler } from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  compareMutationFence,
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export interface LocalDispatchCancellationHighWatermark {
  readonly desiredEffect: "dispatch_submit" | "dispatch_cancel";
  readonly desiredVersion: number;
  readonly fingerprint: string;
}

export function createLocalDispatchCanceler(
  effects: Map<string, "accepted" | "canceled">,
  highWatermarks = new Map<string, LocalDispatchCancellationHighWatermark>(),
  nowMs: () => number = Date.now,
): DispatchCanceler {
  const canceler: DispatchCanceler = {
    cancel(input) {
      const mutationFence: MutationFence = input.mutationFence;
      validateMutationFence(mutationFence);
      const fingerprint = fingerprintMutationFence(mutationFence);
      const comparison = compareMutationFence(
        mutationFence,
        input.authority,
        nowMs(),
      );
      if (
        mutationFence.desiredEffect !== "dispatch_cancel" ||
        mutationFence.requiredGate !== "cancel" ||
        mutationFence.clusterIncarnation !== "synthetic-phase1-cluster" ||
        !mutationFence.namespaceId.startsWith("test://phase1/") ||
        mutationFence.effectScopeKey !== `dispatch:${input.dispatchId}` ||
        mutationFence.supersessionKey !== `dispatch:${input.dispatchId}` ||
        mutationFence.allocationId !==
          `allocation-${input.dispatchId.slice("dispatch-".length)}` ||
        comparison !== "current"
      ) {
        throw new Error(
          `local_dispatch_cancellation_fence_mismatch:${comparison}`,
        );
      }
      const priorFence = highWatermarks.get(mutationFence.effectScopeKey);
      if (
        priorFence === undefined ||
        priorFence.desiredVersion > mutationFence.expectedDesiredVersion ||
        (priorFence.desiredVersion === mutationFence.expectedDesiredVersion &&
          priorFence.fingerprint !== fingerprint)
      ) {
        throw new Error("local_dispatch_cancellation_stale_fence");
      }
      highWatermarks.set(mutationFence.effectScopeKey, {
        desiredEffect: "dispatch_cancel",
        desiredVersion: mutationFence.expectedDesiredVersion,
        fingerprint,
      });
      if (effects.has(input.dispatchId)) {
        effects.set(input.dispatchId, "canceled");
      }
    },
  };
  return Object.freeze(canceler);
}
