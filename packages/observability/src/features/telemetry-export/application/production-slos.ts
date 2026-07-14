export type ProductionSloKind = "maximum" | "minimum";

export interface ProductionSloDefinition {
  readonly sloId: string;
  readonly title: string;
  readonly kind: ProductionSloKind;
  readonly objective: number;
  readonly unit: "1" | "ms" | "{effect}" | "{record}";
  readonly window: "5m" | "30d";
  readonly evidenceMetric: string;
}

export const WORKLOAD_FUNNEL_PRODUCTION_SLOS: readonly ProductionSloDefinition[] =
  Object.freeze([
    Object.freeze({
      evidenceMetric: "accepted_api_success_ratio",
      kind: "minimum",
      objective: 0.999,
      sloId: "accepted-api-availability",
      title: "Durable accepted API availability",
      unit: "1",
      window: "30d",
    }),
    Object.freeze({
      evidenceMetric: "control_operation_latency",
      kind: "maximum",
      objective: 250,
      sloId: "control-api-p99-latency",
      title: "Control API p99 latency",
      unit: "ms",
      window: "5m",
    }),
    Object.freeze({
      evidenceMetric: "host_control_latency_under_load",
      kind: "maximum",
      objective: 100,
      sloId: "host-control-p99-under-load",
      title: "Host-control p99 latency under bounded workload pressure",
      unit: "ms",
      window: "5m",
    }),
    Object.freeze({
      evidenceMetric: "reconciliation_lag",
      kind: "maximum",
      objective: 1000,
      sloId: "reconciliation-p99-lag",
      title: "Reconciliation p99 lag",
      unit: "ms",
      window: "5m",
    }),
    Object.freeze({
      evidenceMetric: "stale_mutation_external_effects",
      kind: "maximum",
      objective: 0,
      sloId: "stale-mutation-safety",
      title: "External effects from stale authorities",
      unit: "{effect}",
      window: "30d",
    }),
    Object.freeze({
      evidenceMetric: "backup_history_loss",
      kind: "maximum",
      objective: 0,
      sloId: "backup-history-preservation",
      title: "Accepted or terminal history records lost on restore",
      unit: "{record}",
      window: "30d",
    }),
  ]);

export interface ProductionSloMeasurement {
  readonly sloId: string;
  readonly observed: number;
  readonly sampleCount: number;
}

export interface ProductionSloEvaluation {
  readonly sloId: string;
  readonly objective: number;
  readonly observed: number;
  readonly sampleCount: number;
  readonly status: "pass" | "fail" | "insufficient_data";
}

export function evaluateProductionSlos(
  measurements: readonly ProductionSloMeasurement[],
): readonly ProductionSloEvaluation[] {
  const definitions = new Map(
    WORKLOAD_FUNNEL_PRODUCTION_SLOS.map((definition) => [
      definition.sloId,
      definition,
    ]),
  );
  const bySlo = new Map<string, ProductionSloMeasurement>();
  for (const measurement of measurements) {
    const definition = definitions.get(measurement.sloId);
    if (definition === undefined) throw new Error("unknown_production_slo");
    if (bySlo.has(measurement.sloId))
      throw new Error("duplicate_production_slo_measurement");
    if (
      Number.isFinite(measurement.observed) &&
      (measurement.observed < 0 ||
        (definition.unit === "1" && measurement.observed > 1))
    )
      throw new Error("invalid_production_slo_measurement");
    bySlo.set(measurement.sloId, measurement);
  }
  return Object.freeze(
    WORKLOAD_FUNNEL_PRODUCTION_SLOS.map((definition) => {
      const measurement = bySlo.get(definition.sloId);
      if (
        measurement === undefined ||
        !Number.isFinite(measurement.observed) ||
        !Number.isSafeInteger(measurement.sampleCount) ||
        measurement.sampleCount < 1
      )
        return Object.freeze({
          objective: definition.objective,
          observed: measurement?.observed ?? Number.NaN,
          sampleCount: measurement?.sampleCount ?? 0,
          sloId: definition.sloId,
          status: "insufficient_data" as const,
        });
      const passed =
        definition.kind === "maximum"
          ? measurement.observed <= definition.objective
          : measurement.observed >= definition.objective;
      return Object.freeze({
        objective: definition.objective,
        observed: measurement.observed,
        sampleCount: measurement.sampleCount,
        sloId: definition.sloId,
        status: passed ? ("pass" as const) : ("fail" as const),
      });
    }),
  );
}
