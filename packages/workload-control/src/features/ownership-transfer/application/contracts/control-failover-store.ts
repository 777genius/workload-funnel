import type { ReconciliationClaim } from "@workload-funnel/workload-control/canonical-transaction-coordination";

import type { ControlServiceFailoverOperation } from "../../domain/control-service-failover.js";

export interface ControlFailoverStore {
  create(
    operation: ControlServiceFailoverOperation,
  ): ControlServiceFailoverOperation;
  get(operationId: string): ControlServiceFailoverOperation | undefined;
  compareAndSet(
    expectedVersion: number,
    next: ControlServiceFailoverOperation,
    claim: ReconciliationClaim,
    now: number,
  ): ControlServiceFailoverOperation;
  discoverIncomplete(limit: number): readonly ControlServiceFailoverOperation[];
}
