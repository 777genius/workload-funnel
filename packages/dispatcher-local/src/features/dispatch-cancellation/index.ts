import type { DispatchCanceler } from "@workload-funnel/workload-control/dispatch-reconciliation";

export function createLocalDispatchCanceler(
  effects: Map<string, "accepted" | "canceled">,
): DispatchCanceler {
  const canceler: DispatchCanceler = {
    cancel(dispatchId) {
      if (effects.has(dispatchId)) effects.set(dispatchId, "canceled");
    },
  };
  return Object.freeze(canceler);
}
