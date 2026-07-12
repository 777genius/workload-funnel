import type { ResourceRequest } from "@workload-funnel/workload-control/workload-lifecycle";

export interface Allocation {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly nodeId: "synthetic-node-1";
  readonly resources: ResourceRequest;
  readonly state: "reserved" | "claimed" | "active" | "releasing" | "released";
  readonly version: number;
}

export interface CapacitySnapshot {
  readonly totalCpuMillis: number;
  readonly totalMemoryMiB: number;
  readonly reservedCpuMillis: number;
  readonly reservedMemoryMiB: number;
  readonly revision: number;
}

export interface ReservationRollbackReceipt {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly kind: "nonterminal_attachment_rollback";
  readonly reservationRevision: number;
}

export interface AllocationReleaseReceipt {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly kind: "terminal_release";
  readonly proofId: string;
}

export class CapacityUnavailableError extends Error {
  public constructor() {
    super("Static capacity reservation would overcommit a hard dimension");
    this.name = "CapacityUnavailableError";
  }
}
