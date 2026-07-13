import { describe, expect, it } from "vitest";

import { createStructuredRedactor } from "@workload-funnel/observability/redaction-policy";
import {
  createTelemetryProvider,
  evaluateServiceHealth,
  WORKLOAD_FUNNEL_DASHBOARDS,
  WORKLOAD_FUNNEL_METRICS,
} from "@workload-funnel/observability/telemetry-export";

describe("Phase 5 redaction and observability semantics", () => {
  it("redacts secrets and quarantines prompts recursively before structured export", () => {
    const secretKeys = new Set(["vaultValue"]);
    const redactor = createStructuredRedactor({
      maximumArrayLength: 2,
      maximumDepth: 4,
      maximumStringLength: 32,
      policyVersion: 1,
      secretKeys,
      sensitiveKeys: new Set(["providerPayload"]),
    });
    const result = redactor.redact({
      Authorization: "Bearer do-not-leak",
      nested: {
        password: "do-not-leak",
        prompt: "private prompt",
        providerPayload: { raw: "private" },
        safe: "visible",
      },
      vault_value: "secret",
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("private prompt");
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[quarantined]");
    secretKeys.clear();
    const cyclic: Record<string, unknown> = { vaultValue: "still-secret" };
    cyclic["self"] = cyclic;
    expect(JSON.stringify(redactor.redact(cyclic).value)).toBe(
      '{"vaultValue":"[redacted]","self":"[circular]"}',
    );
  });

  it("exports bounded-cardinality metrics and traces without making trace delivery correctness-critical", () => {
    const points: unknown[] = [];
    const provider = createTelemetryProvider(
      Object.freeze({
        log: () => undefined,
        metric(point: unknown) {
          points.push(point);
        },
        span: () => undefined,
      }),
      Object.freeze({ redact: (value: unknown) => Object.freeze({ value }) }),
    );
    provider.recordMetric(
      "workload_state",
      1,
      Object.freeze({ state: "running" }),
      1,
    );
    expect(points).toHaveLength(1);
    expect(() => {
      provider.recordMetric(
        "workload_state",
        1,
        Object.freeze({ workload_id: "workload-1" }),
        1,
      );
    }).toThrow("invalid_metric_labels");
    provider.startSpan({
      attributes: Object.freeze({ operation: "submit" }),
      correlationId: "correlation-1",
      spanId: "span-1",
      stage: "request",
      startedAt: 1,
      traceId: "trace-1",
    });
    provider.endSpan("span-1", 2, "ok");
    expect(provider.snapshot().spans[0]).toMatchObject({ outcome: "ok" });

    const unavailableExporter = createTelemetryProvider(
      Object.freeze({
        log() {
          throw new Error("exporter_unavailable");
        },
        metric() {
          throw new Error("exporter_unavailable");
        },
        span() {
          throw new Error("exporter_unavailable");
        },
      }),
      Object.freeze({ redact: (value: unknown) => Object.freeze({ value }) }),
    );
    expect(() => {
      unavailableExporter.recordMetric(
        "workload_state",
        1,
        { state: "queued" },
        2,
      );
    }).not.toThrow();
  });

  it("distinguishes liveness, readiness, degraded operation, and node schedulability", () => {
    const health = evaluateServiceHealth({
      admissionPath: "unsafe",
      cancellationPath: "available",
      canonicalStore: "available",
      internalLoop: "progressing",
      nodeSchedulability: Object.freeze({ "node-1": "cordoned" }),
      observationPath: "available",
      outboxPublisher: "progressing",
    });
    expect(health).toMatchObject({
      liveness: "live",
      readiness: "ready",
      serviceMode: "degraded_observe_cancel_only",
      nodeSchedulability: { "node-1": "cordoned" },
    });
    expect(
      evaluateServiceHealth({
        admissionPath: "available",
        cancellationPath: "available",
        canonicalStore: "available",
        internalLoop: "stalled",
        nodeSchedulability: Object.freeze({}),
        observationPath: "available",
        outboxPublisher: "progressing",
      }),
    ).toMatchObject({
      liveness: "failed",
      readiness: "not_ready",
      serviceMode: "unavailable",
    });
  });

  it("ships dashboards that reference only declared metrics", () => {
    const metricNames = new Set(
      WORKLOAD_FUNNEL_METRICS.map((metric) => metric.name),
    );
    expect(WORKLOAD_FUNNEL_DASHBOARDS.length).toBeGreaterThan(0);
    for (const dashboard of WORKLOAD_FUNNEL_DASHBOARDS)
      for (const panel of dashboard.panels)
        expect(panel.metricNames.every((name) => metricNames.has(name))).toBe(
          true,
        );
  });
});
