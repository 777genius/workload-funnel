import type { MutationFence } from "@workload-funnel/kernel";
import {
  GatewayContractError,
  applySchedulerAuthorityHighWatermarkPlan,
  compareSchedulerFenceToHighWatermarks,
  planSchedulerAuthorityHighWatermarks,
  type InstalledFenceComparison,
  type SchedulerAuthorityHighWatermarkPlan,
  type SchedulerMutationScope,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import type { GatewayRegistryRuntime } from "./gateway-registry-runtime.js";

export function combineAuthorityComparisons(
  perEffect: InstalledFenceComparison,
  crossScope: SchedulerAuthorityHighWatermarkPlan["comparison"],
): InstalledFenceComparison {
  if (perEffect === "lower" || crossScope === "lower") return "lower";
  if (
    perEffect === "equal_version_mismatch" ||
    crossScope === "equal_version_mismatch"
  )
    return "equal_version_mismatch";
  if (perEffect === "dominates" || crossScope === "dominates")
    return "dominates";
  return "equal";
}

export function planCrossScopeInstall(
  runtime: GatewayRegistryRuntime,
  fence: MutationFence,
  scope: SchedulerMutationScope,
): SchedulerAuthorityHighWatermarkPlan {
  return planSchedulerAuthorityHighWatermarks(
    runtime.highWatermarks,
    fence,
    scope,
  );
}

export function applyCrossScopeInstall(
  runtime: GatewayRegistryRuntime,
  plan: SchedulerAuthorityHighWatermarkPlan,
  installedScopeKey: string,
): void {
  applySchedulerAuthorityHighWatermarkPlan(runtime.highWatermarks, plan);
  for (const [key, state] of runtime.scopes) {
    if (key === installedScopeKey || state.fence === undefined) continue;
    if (state.scope === undefined)
      throw new Error("scheduler_scope_authority_missing");
    const comparison = compareSchedulerFenceToHighWatermarks(
      runtime.highWatermarks,
      state.fence,
      state.scope,
    );
    if (comparison === "equal") continue;
    if (comparison === "lower" || comparison === "equal_version_mismatch") {
      state.closed = true;
      state.invalidatedByCrossScope = true;
      state.startupRevalidationRequired = false;
      delete state.acknowledgement;
      continue;
    }
    throw new Error("scheduler_cross_scope_authority_unprovable");
  }
}

export function assertCurrentCrossScopeAuthority(
  runtime: GatewayRegistryRuntime,
  fence: MutationFence,
  scope: SchedulerMutationScope,
): InstalledFenceComparison {
  const comparison = compareSchedulerFenceToHighWatermarks(
    runtime.highWatermarks,
    fence,
    scope,
  );
  if (comparison === "missing")
    throw new GatewayContractError(
      "gateway_cordoned",
      "cross_scope_authority_missing",
    );
  return comparison;
}
