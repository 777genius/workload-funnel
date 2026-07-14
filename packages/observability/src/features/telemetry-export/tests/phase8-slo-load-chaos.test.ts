import { describe, expect, it } from "vitest";

import {
  evaluateProductionSlos,
  WORKLOAD_FUNNEL_DASHBOARDS,
  WORKLOAD_FUNNEL_METRICS,
} from "../index.js";

describe("Phase 8 production SLO and dashboard definitions", () => {
  it("wires every Phase 8 dashboard signal to a bounded metric definition", () => {
    const metricNames = new Set(
      WORKLOAD_FUNNEL_METRICS.map((definition) => definition.name),
    );
    const dashboard = WORKLOAD_FUNNEL_DASHBOARDS.find(
      (candidate) => candidate.dashboardId === "phase8-production-safety",
    );
    expect(dashboard).toBeDefined();
    for (const panel of dashboard?.panels ?? [])
      for (const metricName of panel.metricNames)
        expect(metricNames.has(metricName)).toBe(true);
    for (const metric of WORKLOAD_FUNNEL_METRICS)
      expect(metric.labelKeys).not.toEqual(
        expect.arrayContaining([
          "workload_id",
          "run_id",
          "attempt_id",
          "allocation_id",
        ]),
      );
  });

  it("fails an SLO explicitly instead of treating missing or excessive samples as passing", () => {
    const evaluations = evaluateProductionSlos([
      {
        observed: 101,
        sampleCount: 10,
        sloId: "host-control-p99-under-load",
      },
    ]);
    expect(
      evaluations.find(
        (evaluation) => evaluation.sloId === "host-control-p99-under-load",
      )?.status,
    ).toBe("fail");
    expect(
      evaluations.find(
        (evaluation) => evaluation.sloId === "accepted-api-availability",
      )?.status,
    ).toBe("insufficient_data");
    expect(() =>
      evaluateProductionSlos([
        { observed: 1, sampleCount: 1, sloId: "accepted-api-availability" },
        { observed: 1, sampleCount: 1, sloId: "accepted-api-availability" },
      ]),
    ).toThrow("duplicate_production_slo_measurement");
  });
});
