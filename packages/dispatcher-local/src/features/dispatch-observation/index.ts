import type { DispatchObserver } from "@workload-funnel/workload-control/dispatch-reconciliation";

export function createLocalDispatchObserver(
  effects: ReadonlyMap<string, "accepted" | "canceled">,
): DispatchObserver {
  return Object.freeze({
    observe: (dispatchId: string) => effects.get(dispatchId) ?? "absent",
  });
}
