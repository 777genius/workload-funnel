import type { Execution } from "../../domain/execution.js";

export interface ExecutionStore {
  create(execution: Execution): Execution;
  getByDispatch(dispatchId: string): Execution | undefined;
  save(execution: Execution): void;
}
