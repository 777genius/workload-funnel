import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import type { Dispatch } from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  assertGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type {
  Attempt,
  TerminalOutcome,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type { ExecutionStore } from "./contracts/execution-store.js";
import type { Execution, ExecutorObservation } from "../domain/execution.js";

export interface DeterministicExecutor {
  start(
    attempt: Attempt,
    allocation: Allocation,
    dispatch: Dispatch,
  ): Execution;
  observeTerminal(
    dispatchId: string,
    outcome: TerminalOutcome,
  ): ExecutorObservation;
  stop(dispatchId: string): ExecutorObservation | undefined;
  get(dispatchId: string): Execution | undefined;
}

export function createDeterministicExecutor(
  store: ExecutionStore,
  gates: () => OperationGateSet,
): DeterministicExecutor {
  const executor: DeterministicExecutor = {
    start(attempt, allocation, dispatch) {
      const prior = store.getByDispatch(dispatch.dispatchId);
      if (prior !== undefined) return prior;
      assertGateOpen(gates(), "start");
      if (
        attempt.startAuthorization !== "authorized" ||
        dispatch.observed === "suppressed"
      ) {
        throw new Error(
          "A revoked or suppressed start cannot create an execution",
        );
      }
      const execution: Execution = Object.freeze({
        allocationId: allocation.allocationId,
        attemptId: attempt.attemptId,
        dispatchId: dispatch.dispatchId,
        executionGeneration: attempt.executionGeneration,
        executionId: `execution-${attempt.attemptId.slice("attempt-".length)}`,
        observationSequence: 1,
        state: "running",
        version: 1,
      });
      return store.create(execution);
    },
    observeTerminal(dispatchId, outcome) {
      const execution = store.getByDispatch(dispatchId);
      if (execution === undefined) throw new Error("Execution does not exist");
      const terminal: Execution = Object.freeze({
        ...execution,
        observationSequence: execution.observationSequence + 1,
        state: outcome === "canceled" ? "stopped" : "exited",
        terminalOutcome: outcome,
        version: execution.version + 1,
      });
      store.save(terminal);
      return Object.freeze({
        executionId: terminal.executionId,
        sequence: terminal.observationSequence,
        state: outcome === "canceled" ? "stopped" : "exited",
        terminalOutcome: outcome,
      });
    },
    stop(dispatchId) {
      const execution = store.getByDispatch(dispatchId);
      if (execution === undefined) return undefined;
      const stopped: Execution = Object.freeze({
        ...execution,
        observationSequence: execution.observationSequence + 1,
        state: "stopped",
        terminalOutcome: "canceled",
        version: execution.version + 1,
      });
      store.save(stopped);
      return Object.freeze({
        executionId: stopped.executionId,
        sequence: stopped.observationSequence,
        state: "stopped",
        terminalOutcome: "canceled",
      });
    },
    get: (dispatchId) => store.getByDispatch(dispatchId),
  };
  return Object.freeze(executor);
}
