export const DEFAULT_PRESSURE_POLICY = Object.freeze({
  critical: Object.freeze({
    cpuPsiSome: 0.6,
    ioPsiSome: 0.4,
    loadPerCpu: 1.5,
    memoryAvailableRatio: 0.08,
    memoryPsiSome: 0.4,
    gateDiskUsedRatio: 0.95,
    gateInodeUsedRatio: 0.95,
  }),
  healthyObservationsToReopen: 3,
  high: Object.freeze({
    cpuPsiSome: 0.2,
    ioPsiSome: 0.15,
    loadPerCpu: 0.9,
    memoryAvailableRatio: 0.2,
    memoryPsiSome: 0.15,
    gateDiskUsedRatio: 0.7,
    gateInodeUsedRatio: 0.7,
  }),
  highObservationsToPause: 2,
  maximumObservationAgeMs: 1_500,
  minimumDiskFreeBytes: 8 * 1024 * 1024 * 1024,
  minimumDiskFreeRatio: 0.05,
  minimumInodeFreeRatio: 0.05,
  preflight: Object.freeze({
    cpuPsiSome: 0.1,
    ioPsiSome: 0.08,
    loadPerCpu: 0.75,
    memoryAvailableRatio: 0.3,
    memoryPsiSome: 0.08,
  }),
});

export function parsePsi(text, { requireFull = true } = {}) {
  const parsed = {};
  for (const line of text.trim().split("\n")) {
    const [kind, ...fields] = line.trim().split(/\s+/u);
    if (kind !== "some" && kind !== "full")
      throw new Error("malformed_psi_observation");
    const values = Object.fromEntries(
      fields.map((field) => {
        const separator = field.indexOf("=");
        return [field.slice(0, separator), Number(field.slice(separator + 1))];
      }),
    );
    if (
      !Number.isFinite(values.avg10) ||
      values.avg10 < 0 ||
      values.avg10 > 100 ||
      !Number.isSafeInteger(values.total) ||
      values.total < 0
    )
      throw new Error("malformed_psi_observation");
    parsed[kind] = Object.freeze({
      avg10: values.avg10 / 100,
      total: values.total,
    });
  }
  if (parsed.some === undefined || (requireFull && parsed.full === undefined))
    throw new Error("incomplete_psi_observation");
  return Object.freeze({
    ...parsed,
    full: parsed.full ?? Object.freeze({ avg10: 0, total: 0 }),
  });
}

export function parseMemoryInfo(text) {
  const values = new Map();
  for (const line of text.trim().split("\n")) {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/u);
    if (match !== null) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (!(total > 0) || !(available >= 0) || available > total)
    throw new Error("malformed_memory_observation");
  return Object.freeze({
    availableBytes: available,
    availableRatio: available / total,
    totalBytes: total,
  });
}

export function classifyPressure(
  observation,
  policy = DEFAULT_PRESSURE_POLICY,
) {
  const age = observation.nowMs - observation.observedAtMs;
  if (age < 0 || age > policy.maximumObservationAgeMs)
    return Object.freeze({
      reasons: ["stale_pressure_observation"],
      severity: "critical",
    });
  const reasons = [];
  const compare = (name, value, threshold, inverse = false) => {
    if (inverse ? value <= threshold : value >= threshold) reasons.push(name);
  };
  const level = (thresholds) => {
    reasons.length = 0;
    compare("load", observation.loadPerCpu, thresholds.loadPerCpu);
    compare("cpu_psi", observation.cpuPsiSome, thresholds.cpuPsiSome);
    compare("memory_psi", observation.memoryPsiSome, thresholds.memoryPsiSome);
    compare("io_psi", observation.ioPsiSome, thresholds.ioPsiSome);
    compare(
      "gate_disk",
      observation.gateDiskUsedRatio ?? 0,
      thresholds.gateDiskUsedRatio,
    );
    compare(
      "gate_inodes",
      observation.gateInodeUsedRatio ?? 0,
      thresholds.gateInodeUsedRatio,
    );
    compare(
      "memory_available",
      observation.memoryAvailableRatio,
      thresholds.memoryAvailableRatio,
      true,
    );
    return [...reasons];
  };
  const critical = level(policy.critical);
  if (critical.length > 0)
    return Object.freeze({
      reasons: Object.freeze(critical),
      severity: "critical",
    });
  const high = level(policy.high);
  if (high.length > 0)
    return Object.freeze({ reasons: Object.freeze(high), severity: "high" });
  return Object.freeze({ reasons: Object.freeze([]), severity: "healthy" });
}

export function admitPreflight(observation, policy = DEFAULT_PRESSURE_POLICY) {
  const diskUnsafe =
    observation.diskFreeBytes < policy.minimumDiskFreeBytes ||
    observation.diskFreeRatio < policy.minimumDiskFreeRatio;
  const inodeUnsafe = observation.inodeFreeRatio < policy.minimumInodeFreeRatio;
  const thresholds = policy.preflight;
  const unsafe =
    observation.nowMs < observation.observedAtMs ||
    observation.nowMs - observation.observedAtMs >
      policy.maximumObservationAgeMs ||
    observation.loadPerCpu >= thresholds.loadPerCpu ||
    observation.cpuPsiSome >= thresholds.cpuPsiSome ||
    observation.memoryPsiSome >= thresholds.memoryPsiSome ||
    observation.ioPsiSome >= thresholds.ioPsiSome ||
    observation.memoryAvailableRatio <= thresholds.memoryAvailableRatio ||
    diskUnsafe ||
    inodeUnsafe;
  return Object.freeze({
    producerAdmission: unsafe ? "paused" : "open",
    protectedControl: Object.freeze({
      cancel: true,
      health: true,
      status: true,
    }),
    reason: unsafe
      ? "host_preflight_headroom_insufficient"
      : "headroom_satisfied",
    thresholds: Object.freeze({
      minimumDiskFreeBytes: policy.minimumDiskFreeBytes,
      minimumDiskFreeRatio: policy.minimumDiskFreeRatio,
      minimumInodeFreeRatio: policy.minimumInodeFreeRatio,
    }),
  });
}

export class ProducerPressureGate {
  #healthy = 0;
  #high = 0;
  #state = "open";

  constructor(policy = DEFAULT_PRESSURE_POLICY) {
    this.policy = policy;
  }

  observe(observation) {
    const classification = classifyPressure(observation, this.policy);
    if (classification.severity === "critical") {
      this.#state = "aborted";
      return Object.freeze({ classification, producerAdmission: "aborted" });
    }
    if (classification.severity === "high") {
      this.#healthy = 0;
      this.#high += 1;
      if (this.#high >= this.policy.highObservationsToPause)
        this.#state = "paused";
    } else {
      this.#high = 0;
      this.#healthy += 1;
      if (
        this.#state === "paused" &&
        this.#healthy >= this.policy.healthyObservationsToReopen
      )
        this.#state = "open";
    }
    return Object.freeze({ classification, producerAdmission: this.#state });
  }
}
