import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import type { Dispatch } from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  assertGateOpen,
  assertMutationFenceGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type { MutationFence } from "@workload-funnel/kernel";
import type {
  Attempt,
  TerminalOutcome,
} from "@workload-funnel/workload-control/workload-lifecycle";

import type { ExecutionStore } from "./contracts/execution-store.js";
import type { Execution, ExecutorObservation } from "../domain/execution.js";

export interface DeterministicExecutor {
  start(command: ExecutionStartCommand): Execution;
  observeTerminal(
    dispatchId: string,
    outcome: TerminalOutcome,
  ): ExecutorObservation;
  stop(command: ExecutionStopCommand): ExecutorObservation | undefined;
  get(dispatchId: string): Execution | undefined;
}

export interface ExecutionStartCommand {
  readonly allocation: Allocation;
  readonly attempt: Attempt;
  readonly dispatch: Dispatch;
  readonly mutationFence: MutationFence;
}

export interface ExecutionStopCommand {
  readonly dispatchId: string;
  readonly mutationFence: MutationFence;
}

export function createExecutionStartCommand(
  attempt: Attempt,
  allocation: Allocation,
  dispatch: Dispatch,
  mutationFence: MutationFence,
): ExecutionStartCommand {
  return Object.freeze({ allocation, attempt, dispatch, mutationFence });
}

export function createDeterministicExecutor(
  store: ExecutionStore,
  gates: () => OperationGateSet,
): DeterministicExecutor {
  const executor: DeterministicExecutor = {
    start(command) {
      const { allocation, attempt, dispatch, mutationFence } = command;
      const prior = store.getByDispatch(dispatch.dispatchId);
      if (prior !== undefined) return prior;
      assertGateOpen(gates(), "start");
      assertMutationFenceGateOpen(gates(), mutationFence, "process_start");
      if (
        attempt.startAuthorization !== "authorized" ||
        dispatch.observed === "suppressed"
      ) {
        throw new Error(
          "A revoked or suppressed start cannot create an execution",
        );
      }
      if (
        mutationFence.desiredEffect !== "process_start" ||
        mutationFence.attemptId !== attempt.attemptId ||
        mutationFence.executionGeneration !== attempt.executionGeneration ||
        mutationFence.allocationId !== allocation.allocationId ||
        mutationFence.ownerFence !== allocation.ownerFence ||
        mutationFence.effectScopeKey !== `process:${attempt.attemptId}` ||
        mutationFence.supersessionKey !== mutationFence.effectScopeKey
      ) {
        throw new Error("execution_start_fence_mismatch");
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
    stop(command) {
      const execution = store.getByDispatch(command.dispatchId);
      if (execution === undefined) return undefined;
      assertMutationFenceGateOpen(gates(), command.mutationFence, "cancel");
      if (
        command.mutationFence.desiredEffect !== "process_stop" ||
        command.mutationFence.attemptId !== execution.attemptId ||
        command.mutationFence.executionGeneration !==
          execution.executionGeneration ||
        command.mutationFence.allocationId !== execution.allocationId ||
        command.mutationFence.effectScopeKey !==
          `process:${execution.attemptId}` ||
        command.mutationFence.supersessionKey !==
          command.mutationFence.effectScopeKey
      ) {
        throw new Error("execution_stop_fence_mismatch");
      }
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
