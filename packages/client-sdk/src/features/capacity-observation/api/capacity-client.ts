import type { DerivedCapacitySnapshot } from "@workload-funnel/workload-control/capacity-management";

export interface CapacityTransport {
  request<T>(
    input: Readonly<{
      method: "GET";
      path: string;
      query: Readonly<Record<string, string>>;
    }>,
  ): Promise<T>;
}

export interface CapacityResponseV1 {
  readonly contractVersion: "workload-funnel.capacity/v1";
  readonly effectiveTenantId: string;
  readonly observedAt: number;
  readonly snapshots: readonly DerivedCapacitySnapshot[];
}

export function createCapacityObservationClient(
  transport: CapacityTransport,
  tenantId: string,
): Readonly<{ observe(): Promise<CapacityResponseV1> }> {
  return Object.freeze({
    observe: () =>
      transport.request<CapacityResponseV1>({
        method: "GET",
        path: "/v1/capacity",
        query: Object.freeze({ tenant: tenantId }),
      }),
  });
}
