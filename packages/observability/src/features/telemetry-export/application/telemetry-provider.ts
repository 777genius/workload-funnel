import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import type { CancellationSaga } from "@workload-funnel/workload-control/cancellation";
import type { DerivedCapacitySnapshot } from "@workload-funnel/workload-control/capacity-management";
import type { Dispatch } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { Execution } from "@workload-funnel/workload-control/execution-reconciliation";
import type { NamespaceOwnership } from "@workload-funnel/workload-control/namespace-ownership";
import type { NodeSnapshot } from "@workload-funnel/workload-control/node-lifecycle";
import type { OperationGateSet } from "@workload-funnel/workload-control/operation-gating";
import type { ResultManifest } from "@workload-funnel/workload-control/result-management";
import type { WorkloadStatus } from "@workload-funnel/workload-control/workload-lifecycle";

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly unit: string;
  readonly description: string;
  readonly labelKeys: readonly string[];
}

const metricDefinitions: readonly MetricDefinition[] = [
  {
    name: "workload_state",
    kind: "gauge",
    unit: "{workload}",
    description: "Workloads by bounded lifecycle state",
    labelKeys: ["state"],
  },
  {
    name: "workload_queue_latency",
    kind: "histogram",
    unit: "ms",
    description: "Queue latency",
    labelKeys: ["workload_class"],
  },
  {
    name: "workload_admission_latency",
    kind: "histogram",
    unit: "ms",
    description: "Admission latency",
    labelKeys: ["outcome"],
  },
  {
    name: "workload_startup_latency",
    kind: "histogram",
    unit: "ms",
    description: "Startup latency",
    labelKeys: ["adapter"],
  },
  {
    name: "workload_execution_duration",
    kind: "histogram",
    unit: "ms",
    description: "Execution duration",
    labelKeys: ["outcome"],
  },
  {
    name: "workload_retries",
    kind: "counter",
    unit: "{retry}",
    description: "Retries by classification",
    labelKeys: ["classification"],
  },
  {
    name: "delivery_duplicates",
    kind: "counter",
    unit: "{delivery}",
    description: "Duplicate command and event deliveries",
    labelKeys: ["message_kind"],
  },
  {
    name: "reconciliation_lag",
    kind: "gauge",
    unit: "ms",
    description: "Reconciliation lag",
    labelKeys: ["kind"],
  },
  {
    name: "unknown_state_age",
    kind: "gauge",
    unit: "ms",
    description: "Age of unknown state",
    labelKeys: ["kind"],
  },
  {
    name: "lease_events",
    kind: "counter",
    unit: "{event}",
    description: "Lease expiry, takeover and stale fence rejections",
    labelKeys: ["event"],
  },
  {
    name: "allocation_requests",
    kind: "counter",
    unit: "{request}",
    description: "Allocation requests and grants",
    labelKeys: ["outcome"],
  },
  {
    name: "resource_pressure",
    kind: "gauge",
    unit: "1",
    description: "CPU, memory, IO and PID pressure",
    labelKeys: ["dimension", "severity"],
  },
  {
    name: "resource_throttling",
    kind: "counter",
    unit: "{event}",
    description: "Resource throttling observations",
    labelKeys: ["dimension"],
  },
  {
    name: "cancellation_latency",
    kind: "histogram",
    unit: "ms",
    description: "Cancellation convergence latency",
    labelKeys: ["outcome"],
  },
  {
    name: "result_operations",
    kind: "counter",
    unit: "{operation}",
    description: "Result publication and retention outcomes",
    labelKeys: ["operation", "outcome"],
  },
  {
    name: "adapter_errors",
    kind: "counter",
    unit: "{error}",
    description: "Adapter errors and capability mismatches",
    labelKeys: ["adapter", "reason"],
  },
  {
    name: "admission_deferrals",
    kind: "counter",
    unit: "{deferral}",
    description: "Fairness and quota deferrals",
    labelKeys: ["reason", "workload_class"],
  },
  {
    name: "delivery_backlog",
    kind: "gauge",
    unit: "{message}",
    description: "Outbox and inbox backlog",
    labelKeys: ["queue"],
  },
  {
    name: "heartbeat_freshness",
    kind: "gauge",
    unit: "ms",
    description: "Controller and node heartbeat freshness",
    labelKeys: ["source"],
  },
  {
    name: "http_requests",
    kind: "counter",
    unit: "{request}",
    description: "HTTP requests by stable route and result",
    labelKeys: ["method", "route", "status"],
  },
  {
    name: "http_duration",
    kind: "histogram",
    unit: "ms",
    description: "HTTP request duration",
    labelKeys: ["method", "route"],
  },
  {
    name: "accepted_api_success_ratio",
    kind: "gauge",
    unit: "1",
    description: "Durably confirmed acceptance success ratio",
    labelKeys: ["durability_profile"],
  },
  {
    name: "control_operation_latency",
    kind: "histogram",
    unit: "ms",
    description: "Observation, cancellation, and host-control latency",
    labelKeys: ["operation", "outcome"],
  },
  {
    name: "host_control_latency_under_load",
    kind: "histogram",
    unit: "ms",
    description: "Protected host-control latency during bounded load",
    labelKeys: ["operation"],
  },
  {
    name: "stale_mutation_external_effects",
    kind: "counter",
    unit: "{effect}",
    description: "External effects incorrectly executed by stale authorities",
    labelKeys: ["authority"],
  },
  {
    name: "service_identity_events",
    kind: "counter",
    unit: "{event}",
    description:
      "Enrollment, rotation, revocation, quarantine, and replay results",
    labelKeys: ["event", "outcome"],
  },
  {
    name: "node_maintenance",
    kind: "gauge",
    unit: "{operation}",
    description: "Cordon, drain, reboot, and reconciliation operations",
    labelKeys: ["kind", "state"],
  },
  {
    name: "backup_history_loss",
    kind: "gauge",
    unit: "{record}",
    description: "Accepted or terminal history records missing after restore",
    labelKeys: ["history_kind"],
  },
  {
    name: "disaster_recovery",
    kind: "gauge",
    unit: "{operation}",
    description: "Restore quarantine and disaster recovery phase",
    labelKeys: ["phase", "outcome"],
  },
  {
    name: "slo_burn_rate",
    kind: "gauge",
    unit: "1",
    description: "Bounded SLO error-budget burn rate",
    labelKeys: ["slo", "window"],
  },
];

export const WORKLOAD_FUNNEL_METRICS: readonly MetricDefinition[] =
  Object.freeze(
    metricDefinitions.map((definition) =>
      Object.freeze({
        ...definition,
        labelKeys: Object.freeze(definition.labelKeys),
      }),
    ),
  );

export interface MetricPoint {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly observedAt: number;
}

export interface TraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly correlationId: string;
  readonly stage:
    | "request"
    | "admission"
    | "allocation"
    | "dispatch"
    | "execution"
    | "result_publication"
    | "event_delivery";
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly outcome?: "ok" | "error" | "unknown";
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

export interface StructuredLogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly occurredAt: number;
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface TelemetrySink {
  metric(point: MetricPoint): void;
  span(span: TraceSpan): void;
  log(record: StructuredLogRecord): void;
}

export interface StructuredRedactor {
  redact(value: unknown): Readonly<{ value: unknown }>;
}

export interface TelemetryProvider {
  recordMetric(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>>,
    now: number,
  ): void;
  startSpan(span: Omit<TraceSpan, "endedAt" | "outcome">): void;
  endSpan(
    spanId: string,
    endedAt: number,
    outcome: "ok" | "error" | "unknown",
  ): void;
  log(record: StructuredLogRecord): void;
  recordDomainSnapshot(snapshot: TelemetryDomainSnapshot, now: number): void;
  snapshot(): Readonly<{
    metrics: readonly MetricPoint[];
    spans: readonly TraceSpan[];
    logs: readonly StructuredLogRecord[];
  }>;
}

const forbiddenLabelKeys = new Set([
  "allocation_id",
  "attempt_id",
  "event_id",
  "operation_id",
  "result_manifest_id",
  "run_id",
  "workload_id",
]);
const telemetryHistoryLimit = 4096;

export interface TelemetryDomainSnapshot {
  readonly workloads: readonly WorkloadStatus[];
  readonly allocations: readonly Allocation[];
  readonly cancellations: readonly CancellationSaga[];
  readonly capacity: readonly DerivedCapacitySnapshot[];
  readonly dispatches: readonly Dispatch[];
  readonly executions: readonly Execution[];
  readonly namespaceOwnership: readonly NamespaceOwnership[];
  readonly nodes: readonly NodeSnapshot[];
  readonly gates: readonly OperationGateSet[];
  readonly results: readonly ResultManifest[];
}

export function createTelemetryProvider(
  sink: TelemetrySink,
  redactor: StructuredRedactor,
): TelemetryProvider {
  const definitions = new Map(
    WORKLOAD_FUNNEL_METRICS.map((definition) => [definition.name, definition]),
  );
  const metrics: MetricPoint[] = [];
  const spans = new Map<string, TraceSpan>();
  const logs: StructuredLogRecord[] = [];
  const appendBounded = <T>(items: T[], item: T): void => {
    if (items.length === telemetryHistoryLimit) items.shift();
    items.push(item);
  };
  const exportSafely = (operation: () => void): void => {
    try {
      operation();
    } catch {
      // Exporter availability is intentionally outside correctness paths.
    }
  };
  const provider: TelemetryProvider = {
    endSpan(spanId, endedAt, outcome) {
      const span = spans.get(spanId);
      if (span === undefined || span.endedAt !== undefined)
        throw new Error("trace_span_not_active");
      const ended = Object.freeze({ ...span, endedAt, outcome });
      spans.set(spanId, ended);
      exportSafely(() => {
        sink.span(ended);
      });
    },
    log(record) {
      const redacted = redactor.redact(record.fields);
      const safe = Object.freeze({
        ...record,
        fields: redacted.value as Readonly<Record<string, unknown>>,
        message: record.message.slice(0, 512),
      });
      appendBounded(logs, safe);
      exportSafely(() => {
        sink.log(safe);
      });
    },
    recordMetric(name, value, labels, now) {
      const definition = definitions.get(name);
      if (definition === undefined) throw new Error("unknown_metric");
      if (!Number.isFinite(value)) throw new Error("invalid_metric_value");
      const keys = Object.keys(labels).sort();
      if (
        keys.some((key) => forbiddenLabelKeys.has(key)) ||
        JSON.stringify(keys) !==
          JSON.stringify([...definition.labelKeys].sort()) ||
        Object.values(labels).some((value) => value.length > 64)
      )
        throw new Error("invalid_metric_labels");
      const point = Object.freeze({
        kind: definition.kind,
        labels: Object.freeze({ ...labels }),
        name,
        observedAt: now,
        value,
      });
      appendBounded(metrics, point);
      exportSafely(() => {
        sink.metric(point);
      });
    },
    recordDomainSnapshot(snapshot, now) {
      const workloadCounts = new Map<string, number>();
      for (const item of snapshot.workloads) {
        workloadCounts.set(
          item.attempt.state,
          (workloadCounts.get(item.attempt.state) ?? 0) + 1,
        );
      }
      for (const [state, count] of workloadCounts)
        provider.recordMetric("workload_state", count, { state }, now);
      if (snapshot.nodes.length > 0) {
        const maximumAge = Math.max(
          ...snapshot.nodes.map((node) =>
            Math.max(0, now - node.heartbeatObservedAt),
          ),
        );
        provider.recordMetric(
          "heartbeat_freshness",
          maximumAge,
          { source: "node" },
          now,
        );
      }
      const capacityByStatus = new Map<string, number>();
      for (const item of snapshot.capacity) {
        capacityByStatus.set(
          item.status,
          (capacityByStatus.get(item.status) ?? 0) + 1,
        );
      }
      for (const [severity, count] of capacityByStatus)
        provider.recordMetric(
          "resource_pressure",
          count,
          { dimension: "aggregate", severity },
          now,
        );
    },
    snapshot: () =>
      Object.freeze({
        logs: Object.freeze([...logs]),
        metrics: Object.freeze([...metrics]),
        spans: Object.freeze([...spans.values()]),
      }),
    startSpan(span) {
      if (spans.has(span.spanId)) throw new Error("trace_span_id_conflict");
      if (spans.size === telemetryHistoryLimit) {
        const completed = [...spans].find(
          ([, candidate]) => candidate.endedAt !== undefined,
        );
        if (completed === undefined)
          throw new Error("active_trace_span_capacity_exceeded");
        spans.delete(completed[0]);
      }
      const started = Object.freeze({
        ...span,
        attributes: Object.freeze({ ...span.attributes }),
      });
      spans.set(span.spanId, started);
      exportSafely(() => {
        sink.span(started);
      });
    },
  };
  return Object.freeze(provider);
}
