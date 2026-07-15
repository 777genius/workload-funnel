import { performance } from "node:perf_hooks";

import { ProducerPressureGate } from "./pressure.mjs";
import { PRODUCTION_GATE_SLOS, evaluateMixedWorkloadSlo } from "./slo.mjs";

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
  const maximumSamples = config.maximumSamples ?? 256;
  if (
    !Number.isSafeInteger(config.durationMs) ||
    config.durationMs < 10_000 ||
    config.durationMs > 60_000 ||
    !Number.isSafeInteger(config.maximumIterations) ||
    config.maximumIterations < 1 ||
    config.maximumIterations < 100 ||
    config.maximumIterations > 1_200 ||
    !Number.isSafeInteger(maximumSamples) ||
    maximumSamples < 100 ||
    maximumSamples > 256 ||
    config.protectedControls === null ||
    typeof config.protectedControls !== "object" ||
    !["cancel", "health", "status"].every(
      (name) => typeof config.protectedControls[name] === "function",
    ) ||
    (config.prepare !== undefined && typeof config.prepare !== "function")
  )
    throw new Error("mixed_workload_duration_invalid");
  await config.prepare?.();
  const gate = new ProducerPressureGate(config.policy);
  const started = config.clock();
  const latencies = { cancel: [], health: [], status: [] };
  let accepted = 0;
  let acceptedAfterReopen = 0;
  let protectedControlFailures = 0;
  let observedAbort = false;
  let observedPause = false;
  let observedReopen = false;
  let prior = "open";
  let iterations = 0;
  let producerAdmission = "checking";
  let stopped = false;
  const admissionWaiters = new Set();
  const wakeAdmissionWaiters = () => {
    for (const resolve of admissionWaiters) resolve();
    admissionWaiters.clear();
  };
  const waitForAdmissionChange = () =>
    new Promise((resolve) => admissionWaiters.add(resolve));
  const pressureReasons = new Set();
  const maximumObserved = {
    gateDiskUsedRatio: 0,
    gateInodeUsedRatio: 0,
    workloadCpuPsiSome: 0,
    workloadIoPsiSome: 0,
    workloadMemoryPsiSome: 0,
    observationCollectionMs: 0,
  };
  const observePressure = async () => {
    const minimumSamplesCaptured = () =>
      Object.values(latencies).every(
        (samples) => samples.length >= PRODUCTION_GATE_SLOS.minimumSamples,
      );
    while (
      (config.clock() - started < config.durationMs ||
        !minimumSamplesCaptured()) &&
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
      producerAdmission = decision.producerAdmission;
      wakeAdmissionWaiters();
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
      await config.wait(50);
    }
  };
  const produceAcceptedWork = async () => {
    let attempts = 0;
    while (!stopped && attempts < maximumSamples) {
      if (producerAdmission !== "open") {
        await waitForAdmissionChange();
        continue;
      }
      attempts += 1;
      const admittedAfterReopen = observedReopen;
      if (await config.produce(accepted)) {
        accepted += 1;
        if (admittedAfterReopen) acceptedAfterReopen += 1;
      }
    }
  };
  const measureProtectedControl = async (name) => {
    while (!stopped && latencies[name].length < maximumSamples) {
      const result = await measured(
        config.preciseClock,
        config.protectedControls[name],
      );
      latencies[name].push(result.latencyMs);
      if (!result.passed) protectedControlFailures += 1;
    }
  };
  const workers = [
    produceAcceptedWork(),
    ...["cancel", "health", "status"].map(measureProtectedControl),
  ];
  let observationFailure;
  try {
    await observePressure();
  } catch (error) {
    observationFailure = error;
  } finally {
    stopped = true;
    wakeAdmissionWaiters();
  }
  const workerResults = await Promise.allSettled(workers);
  if (observationFailure !== undefined) throw observationFailure;
  const workerFailure = workerResults.find(
    (result) => result.status === "rejected",
  );
  if (workerFailure?.status === "rejected") throw workerFailure.reason;
  const durationMs = config.clock() - started;
  const slo = evaluateMixedWorkloadSlo({
    accepted,
    acceptedAfterReopen,
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
    acceptedAfterReopen,
    abortedBeforeHostExhaustion: observedAbort,
    durationMs,
    maximumObserved: Object.freeze({ ...maximumObserved }),
    observedPause,
    observedReopen,
    pressureReasons: Object.freeze([...pressureReasons].sort()),
    protectedControlFailures,
    sampleCounts: Object.freeze({
      cancel: latencies.cancel.length,
      health: latencies.health.length,
      status: latencies.status.length,
    }),
    slo,
  });
}

export const monotonicMilliseconds = () => performance.now();
