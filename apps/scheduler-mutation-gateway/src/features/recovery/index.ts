import type { MutationFence } from "@workload-funnel/kernel";
import type { GatewayAuthorityRegistry } from "@workload-funnel/scheduler-mutation-gateway/authority-registry";
import type { HyperQueueMutationBoundary } from "@workload-funnel/scheduler-mutation-gateway/hyperqueue-mutation-boundary";

export interface SchedulerGatewayRecoveryReport {
  readonly mutationReady: boolean;
  readonly observationReady: true;
  readonly reason?:
    | "gateway_registry_unprovable"
    | "authority_revalidation_required"
    | "release_preflight_failed"
    | "unresolved_cli_intent";
  readonly recoveredUnknownOperations: readonly string[];
}

export interface SchedulerGatewayRecovery {
  recover(): Promise<SchedulerGatewayRecoveryReport>;
}

export function createProvider(
  registry: GatewayAuthorityRegistry,
  boundary: HyperQueueMutationBoundary,
): SchedulerGatewayRecovery {
  return Object.freeze({
    async recover(): Promise<SchedulerGatewayRecoveryReport> {
      if (registry.cordonReason !== undefined)
        return {
          mutationReady: false,
          observationReady: true as const,
          reason: "gateway_registry_unprovable",
          recoveredUnknownOperations: [],
        };
      const receipts = registry.recoverUnresolvedAsUnknown();
      for (const receipt of receipts) {
        const recoveredFence: MutationFence = receipt.mutationFence;
        if (recoveredFence.effectScopeKey !== receipt.effectScopeKey)
          throw new Error("gateway_recovery_receipt_mismatch");
      }
      if (receipts.length > 0)
        return {
          mutationReady: false,
          observationReady: true as const,
          reason: "unresolved_cli_intent",
          recoveredUnknownOperations: Object.freeze(
            receipts.map((receipt) => receipt.operationId),
          ),
        };
      try {
        await boundary.initialize();
      } catch {
        return {
          mutationReady: false,
          observationReady: true as const,
          reason: "release_preflight_failed",
          recoveredUnknownOperations: [],
        };
      }
      if (registry.authorityRevalidationRequired)
        return {
          mutationReady: false,
          observationReady: true as const,
          reason: "authority_revalidation_required",
          recoveredUnknownOperations: [],
        };
      return {
        mutationReady: boundary.releaseVerified,
        observationReady: true as const,
        recoveredUnknownOperations: [],
      };
    },
  });
}

export type GatewayProvider = SchedulerGatewayRecovery;
