import {
  evaluateHostPressure,
  type HostPressureHysteresisPolicy,
  type HostPressureObservation,
} from "./host-pressure-hysteresis.js";
import {
  InvalidNodeObservationError,
  StaleNodeRevisionError,
  type NodeSnapshot,
  type VerifiedHostSurvivalProfileBinding,
} from "./node-snapshot.js";

export function recordVerifiedHostSurvivalObservation(
  node: NodeSnapshot,
  expectedVersion: number,
  observation: HostPressureObservation,
  policy: HostPressureHysteresisPolicy,
  binding: VerifiedHostSurvivalProfileBinding,
  now: number,
): NodeSnapshot {
  if (node.version !== expectedVersion) throw new StaleNodeRevisionError();
  if (observation.sourceSequence <= node.lastSourceSequence) {
    throw new InvalidNodeObservationError("stale_source_sequence");
  }
  if (observation.observedAt < node.heartbeatObservedAt) {
    throw new InvalidNodeObservationError("non_monotonic_observation_time");
  }
  const hostPressureState = evaluateHostPressure(
    node.hostPressureState,
    observation,
    policy,
    now,
  );
  return Object.freeze({
    ...node,
    consecutiveHealthyPressure: hostPressureState.consecutiveHealthy,
    consecutiveHighPressure: hostPressureState.consecutiveHigh,
    heartbeatObservedAt: observation.observedAt,
    hostPressureObservation: Object.freeze({
      ...observation,
      cpu: Object.freeze({ ...observation.cpu }),
      io: Object.freeze({ ...observation.io }),
      memory: Object.freeze({ ...observation.memory }),
    }),
    hostPressureState,
    hostSurvivalProfileBinding: Object.freeze({ ...binding }),
    lastSourceSequence: observation.sourceSequence,
    nodeObservationRevision: node.nodeObservationRevision + 1,
    pressure: Object.freeze({
      cpuPsiSome: observation.cpu.someAvg10,
      ioPsiSome: observation.io.someAvg10,
      memoryPsiSome: observation.memory.someAvg10,
      sensorState: observation.sensorState === "fresh" ? "healthy" : "failed",
    }),
    pressureMode: hostPressureState.mode,
    version: node.version + 1,
  });
}
