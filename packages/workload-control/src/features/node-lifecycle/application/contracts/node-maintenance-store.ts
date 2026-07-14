import type {
  NodeMaintenanceClaim,
  NodeMaintenanceOperation,
} from "../../domain/node-maintenance.js";

export interface NodeMaintenanceStore {
  create(operation: NodeMaintenanceOperation): NodeMaintenanceOperation;
  get(operationId: string): NodeMaintenanceOperation | undefined;
  compareAndSet(
    expectedVersion: number,
    next: NodeMaintenanceOperation,
    claim: NodeMaintenanceClaim,
    now: number,
  ): NodeMaintenanceOperation;
  claim(
    operationId: string,
    claimantId: string,
    expectedClaimFence: number,
    now: number,
    leaseUntil: number,
  ): NodeMaintenanceOperation;
  discoverIncomplete(limit: number): readonly NodeMaintenanceOperation[];
}
