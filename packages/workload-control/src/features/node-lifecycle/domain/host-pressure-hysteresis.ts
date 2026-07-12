export type HostPressureDimension =
  | "cpu_psi_full"
  | "cpu_psi_some"
  | "disk"
  | "inodes"
  | "io_psi_full"
  | "io_psi_some"
  | "journal"
  | "memory_available"
  | "memory_psi_full"
  | "memory_psi_some"
  | "node_spool"
  | "pids";

export interface PsiResourceWindow {
  readonly fullAvg10: number;
  readonly someAvg10: number;
}

export interface HostPressureObservation {
  readonly cpu: PsiResourceWindow;
  readonly diskUsedRatio: number;
  readonly inodeUsedRatio: number;
  readonly io: PsiResourceWindow;
  readonly journalUsedRatio: number;
  readonly memory: PsiResourceWindow;
  readonly memoryAvailableRatio: number;
  readonly nodeSpoolUsedRatio: number;
  readonly observedAt: number;
  readonly pidUsedRatio: number;
  readonly sensorState: "failed" | "fresh" | "stale";
  readonly sourceSequence: number;
}

export interface PressureThresholds {
  readonly critical: number;
  readonly high: number;
  readonly soft: number;
}

export interface HostPressureHysteresisPolicy {
  readonly healthyObservationsToRecover: number;
  readonly highObservationsToPause: number;
  readonly maximumObservationAgeMs: number;
  readonly policyId: string;
  readonly revision: number;
  readonly softDerateFactor: number;
  readonly thresholds: Readonly<
    Record<HostPressureDimension, PressureThresholds>
  >;
}

export interface HostPressureState {
  readonly consecutiveHealthy: number;
  readonly consecutiveHigh: number;
  readonly derateFactor: number;
  readonly mode: "critical" | "derated" | "healthy" | "paused";
  readonly observedAt: number;
  readonly reasons: readonly string[];
  readonly sourceSequence: number;
}

function validateRatio(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(code);
}

function pressureValues(
  observation: HostPressureObservation,
): Readonly<Record<HostPressureDimension, number>> {
  return {
    cpu_psi_full: observation.cpu.fullAvg10,
    cpu_psi_some: observation.cpu.someAvg10,
    disk: observation.diskUsedRatio,
    inodes: observation.inodeUsedRatio,
    io_psi_full: observation.io.fullAvg10,
    io_psi_some: observation.io.someAvg10,
    journal: observation.journalUsedRatio,
    memory_available: 1 - observation.memoryAvailableRatio,
    memory_psi_full: observation.memory.fullAvg10,
    memory_psi_some: observation.memory.someAvg10,
    node_spool: observation.nodeSpoolUsedRatio,
    pids: observation.pidUsedRatio,
  };
}

function validatePolicy(policy: HostPressureHysteresisPolicy): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(policy.policyId) ||
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1 ||
    !Number.isSafeInteger(policy.highObservationsToPause) ||
    policy.highObservationsToPause < 1 ||
    !Number.isSafeInteger(policy.healthyObservationsToRecover) ||
    policy.healthyObservationsToRecover < 1 ||
    !Number.isSafeInteger(policy.maximumObservationAgeMs) ||
    policy.maximumObservationAgeMs < 0 ||
    !Number.isFinite(policy.softDerateFactor) ||
    policy.softDerateFactor < 0 ||
    policy.softDerateFactor > 1
  ) {
    throw new Error("invalid_host_pressure_policy");
  }
  for (const thresholds of Object.values(policy.thresholds)) {
    if (
      thresholds.soft < 0 ||
      thresholds.soft >= thresholds.high ||
      thresholds.high >= thresholds.critical ||
      thresholds.critical > 1
    ) {
      throw new Error("invalid_host_pressure_thresholds");
    }
  }
}

function validateObservation(observation: HostPressureObservation): void {
  if (
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 0 ||
    !Number.isSafeInteger(observation.sourceSequence) ||
    observation.sourceSequence < 1
  ) {
    throw new Error("invalid_host_pressure_observation_identity");
  }
  for (const [dimension, value] of Object.entries(
    pressureValues(observation),
  )) {
    validateRatio(value, `invalid_host_pressure:${dimension}`);
  }
}

export function evaluateHostPressure(
  previous: HostPressureState | undefined,
  observation: HostPressureObservation,
  policy: HostPressureHysteresisPolicy,
  now: number,
): HostPressureState {
  validatePolicy(policy);
  validateObservation(observation);
  if (!Number.isSafeInteger(now) || now < observation.observedAt) {
    throw new Error("invalid_host_pressure_evaluation_time");
  }
  if (
    previous !== undefined &&
    (observation.sourceSequence <= previous.sourceSequence ||
      observation.observedAt < previous.observedAt)
  ) {
    throw new Error("stale_host_pressure_sequence");
  }
  const stale =
    observation.sensorState !== "fresh" ||
    now - observation.observedAt > policy.maximumObservationAgeMs;
  if (stale) {
    return Object.freeze({
      consecutiveHealthy: 0,
      consecutiveHigh: (previous?.consecutiveHigh ?? 0) + 1,
      derateFactor: 0,
      mode: "critical",
      observedAt: observation.observedAt,
      reasons: Object.freeze([
        observation.sensorState === "failed" ? "sensor_failed" : "sensor_stale",
      ]),
      sourceSequence: observation.sourceSequence,
    });
  }
  const values = pressureValues(observation);
  const critical = Object.entries(values)
    .filter(
      ([dimension, value]) =>
        value >= policy.thresholds[dimension as HostPressureDimension].critical,
    )
    .map(([dimension]) => `critical:${dimension}`)
    .sort();
  const high = Object.entries(values)
    .filter(
      ([dimension, value]) =>
        value >= policy.thresholds[dimension as HostPressureDimension].high,
    )
    .map(([dimension]) => `high:${dimension}`)
    .sort();
  const soft = Object.entries(values)
    .filter(
      ([dimension, value]) =>
        value >= policy.thresholds[dimension as HostPressureDimension].soft,
    )
    .map(([dimension]) => `soft:${dimension}`)
    .sort();
  const isHealthy = soft.length === 0;
  const consecutiveHigh =
    high.length > 0 ? (previous?.consecutiveHigh ?? 0) + 1 : 0;
  const consecutiveHealthy = isHealthy
    ? (previous?.consecutiveHealthy ?? 0) + 1
    : 0;
  let mode: HostPressureState["mode"];
  let reasons: readonly string[];
  if (critical.length > 0) {
    mode = "critical";
    reasons = critical;
  } else if (
    high.length > 0 &&
    consecutiveHigh >= policy.highObservationsToPause
  ) {
    mode = "paused";
    reasons = high;
  } else if (
    previous !== undefined &&
    (previous.mode === "critical" || previous.mode === "paused") &&
    consecutiveHealthy < policy.healthyObservationsToRecover
  ) {
    mode = previous.mode;
    reasons = Object.freeze(["recovery_hysteresis"]);
  } else if (soft.length > 0) {
    mode = "derated";
    reasons = high.length > 0 ? high : soft;
  } else {
    mode = "healthy";
    reasons = Object.freeze([]);
  }
  return Object.freeze({
    consecutiveHealthy,
    consecutiveHigh,
    derateFactor:
      mode === "healthy" ? 1 : mode === "derated" ? policy.softDerateFactor : 0,
    mode,
    observedAt: observation.observedAt,
    reasons: Object.freeze([...reasons]),
    sourceSequence: observation.sourceSequence,
  });
}
