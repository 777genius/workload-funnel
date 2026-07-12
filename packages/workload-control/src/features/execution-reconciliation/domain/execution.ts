import type { TerminalOutcome } from "@workload-funnel/workload-control/workload-lifecycle";

export interface Execution {
  readonly executionId: string;
  readonly dispatchId: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly state: "prepared" | "running" | "exited" | "stopped";
  readonly terminalOutcome?: TerminalOutcome;
  readonly observationSequence: number;
  readonly version: number;
}

export interface ExecutorObservation {
  readonly executionId: string;
  readonly sequence: number;
  readonly state: "running" | "exited" | "stopped";
  readonly terminalOutcome?: TerminalOutcome;
}
