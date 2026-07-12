import type {
  HostPressureObservation,
  HostPressureState,
} from "./host-pressure-hysteresis.js";

export type NodeSchedulingState =
  | "schedulable"
  | "cordoned"
  | "draining"
  | "retired";

export type PressureMode = "healthy" | "derated" | "paused" | "critical";

export type CapacityEnvelope = Readonly<Record<string, number>>;

export interface NodePressureReport {
  readonly cpuPsiSome: number;
  readonly memoryPsiSome: number;
  readonly ioPsiSome: number;
  readonly sensorState: "healthy" | "failed";
}

export interface PressureHysteresisPolicy {
  readonly softThreshold: number;
  readonly highThreshold: number;
  readonly criticalThreshold: number;
  readonly highObservationsToPause: number;
  readonly healthyObservationsToRecover: number;
}

export interface NodeObservation {
  readonly bootEpoch: string;
  readonly sourceSequence: number;
  readonly observedAt: number;
  readonly capacity: CapacityEnvelope;
  readonly pressure: NodePressureReport;
}

export interface NodeSnapshot {
  readonly nodeId: string;
  readonly poolId: string;
  readonly bootEpoch: string;
  readonly state: NodeSchedulingState;
  readonly capabilities: readonly string[];
  readonly capabilityRevision: number;
  readonly nodeObservationRevision: number;
  readonly version: number;
  readonly lastSourceSequence: number;
  readonly heartbeatObservedAt: number;
  readonly reportedCapacity: CapacityEnvelope;
  readonly pressure: NodePressureReport;
  readonly pressureMode: PressureMode;
  readonly consecutiveHighPressure: number;
  readonly consecutiveHealthyPressure: number;
  readonly hostPressureObservation?: HostPressureObservation;
  readonly hostPressureState?: HostPressureState;
  readonly hostSurvivalProfileBinding?: VerifiedHostSurvivalProfileBinding;
}

export interface VerifiedHostSurvivalProfileBinding {
  readonly policyDigest: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly profileId: string;
  readonly profileRevision: number;
}

export class StaleNodeRevisionError extends Error {
  public constructor() {
    super("stale_node_revision");
    this.name = "StaleNodeRevisionError";
  }
}

export class InvalidNodeObservationError extends Error {
  public constructor(code: string) {
    super(code);
    this.name = "InvalidNodeObservationError";
  }
}

function freezeCapacity(capacity: CapacityEnvelope): CapacityEnvelope {
  const result: Record<string, number> = {};
  for (const [dimension, amount] of Object.entries(capacity).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!dimension || !Number.isSafeInteger(amount) || amount < 0) {
      throw new InvalidNodeObservationError("invalid_capacity_envelope");
    }
    result[dimension] = amount;
  }
  if (Object.keys(result).length === 0) {
    throw new InvalidNodeObservationError("empty_capacity_envelope");
  }
  return Object.freeze(result);
}

function freezeCapabilities(
  capabilities: readonly string[],
): readonly string[] {
  const values = [...new Set(capabilities)].sort();
  if (values.some((capability) => capability.length === 0)) {
    throw new InvalidNodeObservationError("invalid_capability");
  }
  return Object.freeze(values);
}

function maximumPressure(report: NodePressureReport): number {
  return Math.max(report.cpuPsiSome, report.memoryPsiSome, report.ioPsiSome);
}

function validatePressure(report: NodePressureReport): void {
  for (const value of [
    report.cpuPsiSome,
    report.memoryPsiSome,
    report.ioPsiSome,
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new InvalidNodeObservationError("invalid_pressure_report");
    }
  }
}

function validateObservationIdentity(observation: NodeObservation): void {
  if (
    !Number.isSafeInteger(observation.sourceSequence) ||
    observation.sourceSequence < 1 ||
    !Number.isSafeInteger(observation.observedAt) ||
    observation.observedAt < 0
  ) {
    throw new InvalidNodeObservationError("invalid_observation_identity");
  }
}

function validateHysteresisPolicy(policy: PressureHysteresisPolicy): void {
  if (
    policy.softThreshold < 0 ||
    policy.softThreshold >= policy.highThreshold ||
    policy.highThreshold >= policy.criticalThreshold ||
    policy.criticalThreshold > 1 ||
    policy.highObservationsToPause < 1 ||
    policy.healthyObservationsToRecover < 1
  ) {
    throw new InvalidNodeObservationError("invalid_pressure_hysteresis_policy");
  }
}

function nextPressureState(
  current: NodeSnapshot,
  report: NodePressureReport,
  policy: PressureHysteresisPolicy,
): Pick<
  NodeSnapshot,
  "pressureMode" | "consecutiveHighPressure" | "consecutiveHealthyPressure"
> {
  validateHysteresisPolicy(policy);
  validatePressure(report);
  if (report.sensorState === "failed") {
    return {
      pressureMode: "critical",
      consecutiveHealthyPressure: 0,
      consecutiveHighPressure: current.consecutiveHighPressure + 1,
    };
  }

  const pressure = maximumPressure(report);
  const highCount =
    pressure >= policy.highThreshold ? current.consecutiveHighPressure + 1 : 0;
  const healthyCount =
    pressure < policy.softThreshold
      ? current.consecutiveHealthyPressure + 1
      : 0;

  if (pressure >= policy.criticalThreshold) {
    return {
      pressureMode: "critical",
      consecutiveHealthyPressure: 0,
      consecutiveHighPressure: highCount,
    };
  }
  if (highCount >= policy.highObservationsToPause) {
    return {
      pressureMode: "paused",
      consecutiveHealthyPressure: 0,
      consecutiveHighPressure: highCount,
    };
  }
  if (
    ["critical", "paused"].includes(current.pressureMode) &&
    healthyCount < policy.healthyObservationsToRecover
  ) {
    return {
      pressureMode: current.pressureMode,
      consecutiveHealthyPressure: healthyCount,
      consecutiveHighPressure: highCount,
    };
  }
  return {
    pressureMode: pressure >= policy.softThreshold ? "derated" : "healthy",
    consecutiveHealthyPressure: healthyCount,
    consecutiveHighPressure: highCount,
  };
}

export function registerNode(
  input: Readonly<{
    nodeId: string;
    poolId: string;
    bootEpoch: string;
    capabilities: readonly string[];
    observation: NodeObservation;
    pressurePolicy: PressureHysteresisPolicy;
  }>,
): NodeSnapshot {
  if (input.observation.bootEpoch !== input.bootEpoch) {
    throw new InvalidNodeObservationError("boot_epoch_mismatch");
  }
  if (!input.nodeId || !input.poolId || !input.bootEpoch) {
    throw new InvalidNodeObservationError("invalid_node_identity");
  }
  validateObservationIdentity(input.observation);
  validatePressure(input.observation.pressure);
  validateHysteresisPolicy(input.pressurePolicy);
  const pressure = maximumPressure(input.observation.pressure);
  const pressureMode: PressureMode =
    input.observation.pressure.sensorState === "failed" ||
    pressure >= input.pressurePolicy.criticalThreshold
      ? "critical"
      : pressure >= input.pressurePolicy.softThreshold
        ? "derated"
        : "healthy";
  return Object.freeze({
    bootEpoch: input.bootEpoch,
    capabilities: freezeCapabilities(input.capabilities),
    capabilityRevision: 1,
    consecutiveHealthyPressure: pressureMode === "healthy" ? 1 : 0,
    consecutiveHighPressure:
      pressure >= input.pressurePolicy.highThreshold ? 1 : 0,
    heartbeatObservedAt: input.observation.observedAt,
    lastSourceSequence: input.observation.sourceSequence,
    nodeId: input.nodeId,
    nodeObservationRevision: 1,
    poolId: input.poolId,
    pressure: Object.freeze({ ...input.observation.pressure }),
    pressureMode,
    reportedCapacity: freezeCapacity(input.observation.capacity),
    state: "schedulable",
    version: 1,
  });
}

export function replaceNodeCapabilities(
  node: NodeSnapshot,
  expectedVersion: number,
  capabilities: readonly string[],
): NodeSnapshot {
  if (node.version !== expectedVersion) throw new StaleNodeRevisionError();
  return Object.freeze({
    ...node,
    capabilities: freezeCapabilities(capabilities),
    capabilityRevision: node.capabilityRevision + 1,
    version: node.version + 1,
  });
}

export function recordNodeObservation(
  node: NodeSnapshot,
  expectedVersion: number,
  observation: NodeObservation,
  policy: PressureHysteresisPolicy,
): NodeSnapshot {
  if (node.version !== expectedVersion) throw new StaleNodeRevisionError();
  if (observation.bootEpoch !== node.bootEpoch) {
    throw new InvalidNodeObservationError("boot_epoch_mismatch");
  }
  if (observation.sourceSequence <= node.lastSourceSequence) {
    throw new InvalidNodeObservationError("stale_source_sequence");
  }
  validateObservationIdentity(observation);
  if (observation.observedAt < node.heartbeatObservedAt) {
    throw new InvalidNodeObservationError("non_monotonic_observation_time");
  }
  const pressureState = nextPressureState(node, observation.pressure, policy);
  return Object.freeze({
    ...node,
    ...pressureState,
    heartbeatObservedAt: observation.observedAt,
    lastSourceSequence: observation.sourceSequence,
    nodeObservationRevision: node.nodeObservationRevision + 1,
    pressure: Object.freeze({ ...observation.pressure }),
    reportedCapacity: freezeCapacity(observation.capacity),
    version: node.version + 1,
  });
}

export function transitionNodeScheduling(
  node: NodeSnapshot,
  expectedVersion: number,
  next: NodeSchedulingState,
): NodeSnapshot {
  if (node.version !== expectedVersion) throw new StaleNodeRevisionError();
  const allowed: Readonly<
    Record<NodeSchedulingState, readonly NodeSchedulingState[]>
  > = {
    schedulable: ["cordoned", "draining", "retired"],
    cordoned: ["schedulable", "draining", "retired"],
    draining: ["cordoned", "retired"],
    retired: [],
  };
  if (!allowed[node.state].includes(next)) {
    throw new InvalidNodeObservationError("invalid_node_state_transition");
  }
  return Object.freeze({ ...node, state: next, version: node.version + 1 });
}
