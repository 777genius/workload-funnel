export interface DashboardDefinitionV1 {
  readonly contractVersion: "workload-funnel.dashboard/v1";
  readonly dashboardId: string;
  readonly title: string;
  readonly panels: readonly Readonly<{
    panelId: string;
    title: string;
    metricNames: readonly string[];
    visualization: "timeseries" | "stat" | "heatmap";
  }>[];
}

export const WORKLOAD_FUNNEL_DASHBOARDS: readonly DashboardDefinitionV1[] =
  Object.freeze([
    Object.freeze({
      contractVersion: "workload-funnel.dashboard/v1",
      dashboardId: "control-plane-overview",
      panels: Object.freeze([
        Object.freeze({
          panelId: "lifecycle",
          title: "Workload lifecycle",
          metricNames: Object.freeze(["workload_state"]),
          visualization: "stat",
        }),
        Object.freeze({
          panelId: "latency",
          title: "Queue, admission, and startup latency",
          metricNames: Object.freeze([
            "workload_queue_latency",
            "workload_admission_latency",
            "workload_startup_latency",
          ]),
          visualization: "heatmap",
        }),
        Object.freeze({
          panelId: "ambiguity",
          title: "Unknown state and reconciliation",
          metricNames: Object.freeze([
            "unknown_state_age",
            "reconciliation_lag",
          ]),
          visualization: "timeseries",
        }),
        Object.freeze({
          panelId: "delivery",
          title: "Durable delivery backlog",
          metricNames: Object.freeze([
            "delivery_backlog",
            "delivery_duplicates",
          ]),
          visualization: "timeseries",
        }),
      ]),
      title: "WorkloadFunnel control plane",
    }),
    Object.freeze({
      contractVersion: "workload-funnel.dashboard/v1",
      dashboardId: "resource-and-results",
      panels: Object.freeze([
        Object.freeze({
          panelId: "pressure",
          title: "Resource pressure",
          metricNames: Object.freeze([
            "resource_pressure",
            "resource_throttling",
          ]),
          visualization: "timeseries",
        }),
        Object.freeze({
          panelId: "allocation",
          title: "Allocation requests",
          metricNames: Object.freeze([
            "allocation_requests",
            "admission_deferrals",
          ]),
          visualization: "timeseries",
        }),
        Object.freeze({
          panelId: "results",
          title: "Result publication and retention",
          metricNames: Object.freeze(["result_operations"]),
          visualization: "timeseries",
        }),
        Object.freeze({
          panelId: "heartbeat",
          title: "Heartbeat freshness",
          metricNames: Object.freeze(["heartbeat_freshness"]),
          visualization: "stat",
        }),
      ]),
      title: "WorkloadFunnel resources and results",
    }),
  ]);
