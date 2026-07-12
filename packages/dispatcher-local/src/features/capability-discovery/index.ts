import type { DispatchCapabilityProvider } from "@workload-funnel/workload-control/dispatch-reconciliation";

export function createLocalDispatchCapabilityProvider(): DispatchCapabilityProvider {
  return Object.freeze({
    adapter: "dispatcher-local",
    capabilities: Object.freeze(["local_dispatch"] as const),
  });
}
