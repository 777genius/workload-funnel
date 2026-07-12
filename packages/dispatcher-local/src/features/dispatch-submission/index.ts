import type { DispatchSubmitter } from "@workload-funnel/workload-control/dispatch-reconciliation";

export function createLocalDispatchSubmitter(
  effects: Map<string, "accepted" | "canceled">,
): DispatchSubmitter {
  const submitter: DispatchSubmitter = {
    submit(input) {
      const prior = effects.get(input.dispatchId);
      if (prior === "canceled")
        throw new Error("Canceled local dispatch cannot be resubmitted");
      effects.set(input.dispatchId, "accepted");
      return Object.freeze({
        adapterReference: `local://${input.dispatchId}`,
        fingerprint: `local:${input.operationId}:${input.executionGeneration}`,
      });
    },
  };
  return Object.freeze(submitter);
}
