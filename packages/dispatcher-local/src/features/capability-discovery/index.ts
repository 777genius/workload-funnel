import type { DispatchCapabilityProvider } from "@workload-funnel/workload-control/dispatch-reconciliation";

export function createLocalDispatchCapabilityProvider(): DispatchCapabilityProvider {
  return Object.freeze({
    adapter: "dispatcher-local",
    adapterContractVersion: 1,
    capabilities: Object.freeze(["local_dispatch"] as const),
  });
}
