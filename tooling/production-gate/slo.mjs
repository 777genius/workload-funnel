export const PRODUCTION_GATE_SLOS = Object.freeze({
  cancelP99Ms: 750,
  healthP99Ms: 250,
  minimumAcceptedPerSecond: 5,
  minimumDurationMs: 10_000,
  minimumSamples: 100,
  statusP99Ms: 250,
});

export function percentile99(samples) {
  if (
    !Array.isArray(samples) ||
    samples.length === 0 ||
    samples.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("invalid_slo_samples");
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.99) - 1];
}

export function evaluateMixedWorkloadSlo(input, limits = PRODUCTION_GATE_SLOS) {
  if (
    !Number.isFinite(input.durationMs) ||
    input.durationMs < limits.minimumDurationMs ||
    !Number.isSafeInteger(input.accepted) ||
    input.accepted < 0 ||
    !Array.isArray(input.cancelLatenciesMs) ||
    !Array.isArray(input.healthLatenciesMs) ||
    !Array.isArray(input.statusLatenciesMs) ||
    input.cancelLatenciesMs.length < limits.minimumSamples ||
    input.healthLatenciesMs.length < limits.minimumSamples ||
    input.statusLatenciesMs.length < limits.minimumSamples ||
    !Number.isSafeInteger(input.iterations) ||
    input.iterations < limits.minimumSamples ||
    input.protectedControlFailures !== 0
  )
    return Object.freeze({
      passed: false,
      reason: "mixed_workload_measurement_invalid",
    });
  const measurements = Object.freeze({
    acceptedPerSecond: input.accepted / (input.durationMs / 1_000),
    cancelP99Ms: percentile99(input.cancelLatenciesMs),
    healthP99Ms: percentile99(input.healthLatenciesMs),
    statusP99Ms: percentile99(input.statusLatenciesMs),
  });
  const passed =
    measurements.acceptedPerSecond >= limits.minimumAcceptedPerSecond &&
    measurements.cancelP99Ms <= limits.cancelP99Ms &&
    measurements.healthP99Ms <= limits.healthP99Ms &&
    measurements.statusP99Ms <= limits.statusP99Ms;
  return Object.freeze({
    measurements,
    passed,
    reason: passed ? null : "mixed_workload_slo_missed",
  });
}
