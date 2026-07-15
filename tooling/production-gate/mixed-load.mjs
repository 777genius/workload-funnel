import { performance } from "node:perf_hooks";

import { ProducerPressureGate } from "./pressure.mjs";
import { evaluateMixedWorkloadSlo } from "./slo.mjs";

async function measured(clock, operation) {
  const started = clock();
  try {
    const passed = await operation();
    return Object.freeze({
      latencyMs: clock() - started,
      passed: passed !== false,
    });
  } catch {
    return Object.freeze({ latencyMs: clock() - started, passed: false });
  }
}

export async function runMixedWorkloadMeasurement(config) {
  if (
    !Number.isSafeInteger(config.durationMs) ||
    config.durationMs < 10_000 ||
    config.durationMs > 60_000 ||
    !Number.isSafeInteger(config.maximumIterations) ||
    config.maximumIterations < 1 ||
    config.maximumIterations < 100 ||
    config.maximumIterations > 256
  )
    throw new Error("mixed_workload_duration_invalid");
  const gate = new ProducerPressureGate(config.policy);
  const started = config.clock();
  const latencies = { cancel: [], health: [], status: [] };
  let accepted = 0;
  let protectedControlFailures = 0;
  let observedAbort = false;
  let observedPause = false;
  let observedReopen = false;
  let prior = "open";
  let iterations = 0;
  const pressureReasons = new Set();
  const maximumObserved = {
    gateDiskUsedRatio: 0,
    gateInodeUsedRatio: 0,
    workloadCpuPsiSome: 0,
    workloadIoPsiSome: 0,
    workloadMemoryPsiSome: 0,
  };
  while (
    config.clock() - started < config.durationMs &&
    iterations < config.maximumIterations
  ) {
    iterations += 1;
    const observation = await config.observe();
    for (const name of Object.keys(maximumObserved))
      maximumObserved[name] = Math.max(
        maximumObserved[name],
        observation[name] ?? 0,
      );
    const decision = gate.observe(observation);
    for (const reason of decision.classification.reasons)
      pressureReasons.add(reason);
    if (decision.producerAdmission === "paused" && !observedPause) {
      observedPause = true;
      await config.onPause?.();
    }
    if (prior === "paused" && decision.producerAdmission === "open")
      observedReopen = true;
    prior = decision.producerAdmission;
    if (decision.producerAdmission === "aborted") {
      observedAbort = true;
      await config.onAbort?.();
      break;
    }
    if (
      decision.producerAdmission === "open" &&
      (await config.produce(accepted))
    )
      accepted += 1;
    for (const [name, operation] of Object.entries(config.protectedControls)) {
      const result = await measured(config.preciseClock, operation);
      latencies[name].push(result.latencyMs);
      if (!result.passed) protectedControlFailures += 1;
    }
    await config.wait(50);
  }
  const durationMs = config.clock() - started;
  const slo = evaluateMixedWorkloadSlo({
    accepted,
    cancelLatenciesMs: latencies.cancel,
    durationMs,
    iterations,
    healthLatenciesMs: latencies.health,
    protectedControlFailures,
    pressureReasons: Object.freeze([...pressureReasons].sort()),
    statusLatenciesMs: latencies.status,
  });
  return Object.freeze({
    accepted,
    abortedBeforeHostExhaustion: observedAbort,
    durationMs,
    maximumObserved: Object.freeze({ ...maximumObserved }),
    observedPause,
    observedReopen,
    pressureReasons: Object.freeze([...pressureReasons].sort()),
    protectedControlFailures,
    slo,
  });
}

export const monotonicMilliseconds = () => performance.now();
