import type { Dispatch } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { Execution } from "@workload-funnel/workload-control/execution-reconciliation";
import type { OwnershipTransferOperation } from "@workload-funnel/workload-control/ownership-transfer";

export interface ReconciliationRequestContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
}

export interface ReconciliationItemV1 {
  readonly itemId: string;
  readonly kind: "dispatch" | "execution" | "ownership_transfer";
  readonly state:
    | Dispatch["observed"]
    | Execution["state"]
    | OwnershipTransferOperation["state"];
  readonly reason: string;
  readonly observedAt: number;
}

export interface ReconciliationObservationPort {
  list(
    context: ReconciliationRequestContext,
    afterItemId: string | undefined,
    limit: number,
  ): readonly ReconciliationItemV1[];
}

export interface ReconciliationController {
  list(
    context: ReconciliationRequestContext,
    afterItemId: string | undefined,
    limit: number,
  ): Readonly<{
    contractVersion: "workload-funnel.reconciliation-items/v1";
    items: readonly ReconciliationItemV1[];
  }>;
}

export function createReconciliationController(
  port: ReconciliationObservationPort,
): ReconciliationController {
  const controller: ReconciliationController = {
    list(context, afterItemId, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new Error("invalid_reconciliation_page");
      return Object.freeze({
        contractVersion: "workload-funnel.reconciliation-items/v1",
        items: Object.freeze([...port.list(context, afterItemId, limit)]),
      });
    },
  };
  return Object.freeze(controller);
}
