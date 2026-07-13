import type { DerivedCapacitySnapshot } from "@workload-funnel/workload-control/capacity-management";

export interface CapacityRequestContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly authorizationPolicyVersion: number;
}

export interface CapacitySnapshotV1 {
  readonly contractVersion: "workload-funnel.capacity/v1";
  readonly effectiveTenantId: string;
  readonly observedAt: number;
  readonly snapshots: readonly DerivedCapacitySnapshot[];
}

export interface CapacityObservationPort {
  observeCapacity(
    context: CapacityRequestContext,
  ): Omit<CapacitySnapshotV1, "contractVersion" | "effectiveTenantId">;
}

export interface CapacityController {
  observe(context: CapacityRequestContext): CapacitySnapshotV1;
}

export function createCapacityController(
  port: CapacityObservationPort,
): CapacityController {
  const controller: CapacityController = {
    observe(context) {
      const result = port.observeCapacity(context);
      return Object.freeze({
        contractVersion: "workload-funnel.capacity/v1",
        effectiveTenantId: context.effectiveTenantId,
        observedAt: result.observedAt,
        snapshots: Object.freeze([...result.snapshots]),
      });
    },
  };
  return Object.freeze(controller);
}
