export interface DependencyHealth {
  readonly canonicalStore: "available" | "unavailable";
  readonly outboxPublisher: "progressing" | "stalled";
  readonly observationPath: "available" | "unavailable";
  readonly cancellationPath: "available" | "unavailable";
  readonly admissionPath: "available" | "unsafe";
  readonly internalLoop: "progressing" | "stalled";
  readonly nodeSchedulability: Readonly<
    Record<string, "schedulable" | "cordoned" | "draining" | "unknown">
  >;
}

export interface ServiceHealthV1 {
  readonly contractVersion: "workload-funnel.health/v1";
  readonly liveness: "live" | "failed";
  readonly readiness: "ready" | "not_ready";
  readonly serviceMode: "full" | "degraded_observe_cancel_only" | "unavailable";
  readonly reasons: readonly string[];
  readonly nodeSchedulability: DependencyHealth["nodeSchedulability"];
}

export function evaluateServiceHealth(
  dependencies: DependencyHealth,
): ServiceHealthV1 {
  const reasons: string[] = [];
  if (dependencies.canonicalStore === "unavailable")
    reasons.push("canonical_store_unavailable");
  if (dependencies.outboxPublisher === "stalled")
    reasons.push("outbox_publisher_stalled");
  if (dependencies.observationPath === "unavailable")
    reasons.push("observation_unavailable");
  if (dependencies.cancellationPath === "unavailable")
    reasons.push("cancellation_unavailable");
  if (dependencies.admissionPath === "unsafe") reasons.push("admission_unsafe");
  const liveness =
    dependencies.internalLoop === "progressing" ? "live" : "failed";
  const observeAndCancel =
    dependencies.observationPath === "available" &&
    dependencies.cancellationPath === "available";
  const full =
    liveness === "live" &&
    observeAndCancel &&
    dependencies.canonicalStore === "available" &&
    dependencies.outboxPublisher === "progressing" &&
    dependencies.admissionPath === "available";
  return Object.freeze({
    contractVersion: "workload-funnel.health/v1",
    liveness,
    nodeSchedulability: Object.freeze({ ...dependencies.nodeSchedulability }),
    readiness:
      liveness === "live" && (full || observeAndCancel) ? "ready" : "not_ready",
    reasons: Object.freeze(reasons),
    serviceMode: full
      ? "full"
      : observeAndCancel && liveness === "live"
        ? "degraded_observe_cancel_only"
        : "unavailable",
  });
}
