import type { TerminalOutcome } from "@workload-funnel/workload-control/workload-lifecycle";

export interface Execution {
  readonly executionId: string;
  readonly dispatchId: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly state:
    | "prepared"
    | "start_requested"
    | "starting"
    | "running"
    | "stop_requested"
    | "exited"
    | "stopped"
    | "superseded"
    | "unknown"
    | "lost"
    | "reconciliation_required";
  readonly ownerFence?: number;
  readonly writerEpoch?: number;
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
