import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import {
  assertGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";

import type {
  DispatchCanceler,
  DispatchSubmitter,
} from "./contracts/dispatch-adapter.js";
import type { DispatchStore } from "./contracts/dispatch-store.js";
import type { Dispatch, DispatchReceipt } from "../domain/dispatch.js";

export interface LocalDispatcher {
  submit(allocation: Allocation, startAuthorized: boolean): DispatchReceipt;
  cancel(allocationId: string): DispatchReceipt | undefined;
  get(allocationId: string): Dispatch | undefined;
}

export function createLocalDispatcher(
  store: DispatchStore,
  gates: () => OperationGateSet,
  submitter: DispatchSubmitter,
  canceler: DispatchCanceler,
): LocalDispatcher {
  const dispatcher: LocalDispatcher = {
    submit(allocation, startAuthorized) {
      const prior = store.getByAllocation(allocation.allocationId);
      if (prior !== undefined) {
        return Object.freeze({
          dispatchId: prior.dispatchId,
          disposition:
            prior.observed === "suppressed" ? "suppressed" : "accepted",
          operationId: prior.operationId,
        });
      }
      assertGateOpen(gates(), "dispatch");
      const dispatchId = `dispatch-${allocation.allocationId.slice("allocation-".length)}`;
      const operationId = `dispatch-submit:${dispatchId}`;
      const suppressed = !startAuthorized;
      const evidence = suppressed
        ? undefined
        : submitter.submit({
            dispatchId,
            executionGeneration: allocation.executionGeneration,
            operationId,
          });
      const dispatch: Dispatch = Object.freeze({
        adapter: "dispatcher-local",
        allocationId: allocation.allocationId,
        desired: suppressed ? "suppressed" : "submit",
        dispatchId,
        executionGeneration: allocation.executionGeneration,
        observed: suppressed ? "suppressed" : "accepted",
        operationId,
        version: 1,
      });
      store.create(
        dispatch,
        Object.freeze({
          adapterReference:
            evidence?.adapterReference ?? `local-suppressed://${dispatchId}`,
          dispatchId,
          fingerprint: evidence?.fingerprint ?? `suppressed:${operationId}`,
          operationId,
        }),
      );
      return Object.freeze({
        dispatchId,
        disposition: suppressed ? "suppressed" : "accepted",
        operationId,
      });
    },
    cancel(allocationId) {
      const dispatch = store.getByAllocation(allocationId);
      if (dispatch === undefined) return undefined;
      if (dispatch.desired !== "cancel") {
        canceler.cancel(
          dispatch.dispatchId,
          `dispatch-cancel:${dispatch.dispatchId}`,
        );
        store.save(
          Object.freeze({
            ...dispatch,
            desired: "cancel",
            version: dispatch.version + 1,
          }),
        );
      }
      return Object.freeze({
        dispatchId: dispatch.dispatchId,
        disposition: "cancel_requested",
        operationId: `dispatch-cancel:${dispatch.dispatchId}`,
      });
    },
    get: (allocationId) => store.getByAllocation(allocationId),
  };
  return Object.freeze(dispatcher);
}
