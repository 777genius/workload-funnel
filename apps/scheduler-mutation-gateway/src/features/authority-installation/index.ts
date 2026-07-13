import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { GatewayAuthorityRegistry } from "@workload-funnel/scheduler-mutation-gateway/authority-registry";
import type {
  SchedulerScopeCloseRequest,
  SchedulerScopeReopenRequest,
  SignedSchedulerFenceInstall,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export interface GatewayAuthorityInstallation {
  closeAndDrain(
    request: SchedulerScopeCloseRequest,
  ): ReturnType<GatewayAuthorityRegistry["closeAndDrain"]>;
  install(
    request: SignedSchedulerFenceInstall,
  ): ReturnType<GatewayAuthorityRegistry["install"]>;
  reopen(request: SchedulerScopeReopenRequest): Promise<void>;
}

export function createProvider(
  registry: GatewayAuthorityRegistry,
): GatewayAuthorityInstallation {
  return Object.freeze({
    closeAndDrain: (request: SchedulerScopeCloseRequest) =>
      registry.closeAndDrain(request),
    install(request: SignedSchedulerFenceInstall) {
      const fence: MutationFence = request.claims.mutationFence;
      validateMutationFence(fence);
      return registry.install(request);
    },
    reopen: (request: SchedulerScopeReopenRequest) => registry.reopen(request),
  });
}

export type GatewayProvider = GatewayAuthorityInstallation;
