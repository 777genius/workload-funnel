import type { CanonicalTransactionParticipant } from "@workload-funnel/workload-control/canonical-transaction-coordination";
import type { StaticNode } from "@workload-funnel/workload-control/node-lifecycle";

export interface StaticCapacityProfile {
  readonly nodeId: string;
  readonly cpuMillis: number;
  readonly memoryMiB: number;
}

export function deriveStaticCapacity(node: StaticNode): StaticCapacityProfile {
  return Object.freeze({
    cpuMillis: node.capacity.cpuMillis,
    memoryMiB: node.capacity.memoryMiB,
    nodeId: node.nodeId,
  });
}

export function createCapacityManagementTransactionParticipant(): CanonicalTransactionParticipant {
  return Object.freeze({
    id: "capacity-management",
    finalizesRank160: false,
    ownerStoreCount: 1,
    supportedModes: Object.freeze([
      "reserve_acceptance",
      "reserve_staging",
      "rollback_staging",
      "terminal_disposition",
      "verify_disposition",
      "staging_to_result",
      "release_result_bytes",
    ] as const),
  });
}
