import type { NodeSnapshot } from "@workload-funnel/workload-control/node-lifecycle";

export type ResourceAmounts = Readonly<Record<string, number>>;

export type AdmissionLane = "producer" | "recovery";

export interface CapacityDerivationPolicy {
  readonly maxObservationAgeMs: number;
  readonly softPressureFactor: number;
  readonly recoveryReserveRatio: number;
  readonly requiredDimensions: readonly string[];
}

export interface DerivedCapacitySnapshot {
  readonly nodeId: string;
  readonly poolId: string;
  readonly nodeObservationRevision: number;
  readonly observedAt: number;
  readonly reported: ResourceAmounts;
  readonly effective: ResourceAmounts;
  readonly recoveryReserved: ResourceAmounts;
  readonly status:
    | "open"
    | "derated"
    | "producer_paused"
    | "closed_stale"
    | "closed_sensor_failed"
    | "closed_node_state";
  readonly reasons: readonly string[];
}

export interface SafetyBounds {
  readonly backlogCount: number;
  readonly backlogBytes: number;
  readonly diskAvailableBytes: number;
  readonly recoveryDebt: number;
  readonly hardBacklogCount: number;
  readonly hardBacklogBytes: number;
  readonly minimumDiskReserveBytes: number;
  readonly hardRecoveryDebt: number;
}

export type SafetyBoundDecision = Readonly<
  | { status: "open"; reasons: readonly string[] }
  | { status: "closed"; reasons: readonly string[] }
>;

function scaled(
  source: ResourceAmounts,
  factor: number,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).map(([dimension, amount]) => [
        dimension,
        Math.floor(amount * factor),
      ]),
    ),
  );
}

function zero(source: ResourceAmounts): Readonly<Record<string, number>> {
  return scaled(source, 0);
}

function recoveryReserve(
  source: ResourceAmounts,
  ratio: number,
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).map(([dimension, amount]) => [
        dimension,
        Math.ceil(amount * ratio),
      ]),
    ),
  );
}

function validatePolicy(policy: CapacityDerivationPolicy): void {
  if (
    policy.maxObservationAgeMs < 0 ||
    policy.softPressureFactor < 0 ||
    policy.softPressureFactor > 1 ||
    policy.recoveryReserveRatio < 0 ||
    policy.recoveryReserveRatio > 1
  ) {
    throw new Error("invalid_capacity_derivation_policy");
  }
}

export function deriveAdmissionCapacity(
  node: NodeSnapshot,
  now: number,
  policy: CapacityDerivationPolicy,
): DerivedCapacitySnapshot {
  validatePolicy(policy);
  const reported = Object.freeze({ ...node.reportedCapacity });
  const base = {
    nodeId: node.nodeId,
    nodeObservationRevision: node.nodeObservationRevision,
    observedAt: node.heartbeatObservedAt,
    poolId: node.poolId,
    reported,
  } as const;
  const reserve = recoveryReserve(reported, policy.recoveryReserveRatio);

  if (node.state !== "schedulable") {
    return Object.freeze({
      ...base,
      effective: zero(reported),
      reasons: Object.freeze(["node_not_schedulable"]),
      recoveryReserved: reserve,
      status: "closed_node_state",
    });
  }
  if (node.heartbeatObservedAt > now) {
    return Object.freeze({
      ...base,
      effective: zero(reported),
      reasons: Object.freeze(["observation_from_future"]),
      recoveryReserved: reserve,
      status: "closed_stale",
    });
  }
  if (now - node.heartbeatObservedAt > policy.maxObservationAgeMs) {
    return Object.freeze({
      ...base,
      effective: zero(reported),
      reasons: Object.freeze(["heartbeat_stale"]),
      recoveryReserved: reserve,
      status: "closed_stale",
    });
  }
  if (node.pressure.sensorState === "failed") {
    return Object.freeze({
      ...base,
      effective: zero(reported),
      reasons: Object.freeze(["pressure_sensor_failed"]),
      recoveryReserved: reserve,
      status: "closed_sensor_failed",
    });
  }
  const missing = policy.requiredDimensions.filter(
    (dimension) => reported[dimension] === undefined,
  );
  if (missing.length > 0) {
    return Object.freeze({
      ...base,
      effective: zero(reported),
      reasons: Object.freeze(missing.map((value) => `metric_missing:${value}`)),
      recoveryReserved: reserve,
      status: "closed_sensor_failed",
    });
  }

  const pressureMode = node.hostPressureState?.mode ?? node.pressureMode;
  const pressureReasons = node.hostPressureState?.reasons;
  if (["paused", "critical"].includes(pressureMode)) {
    return Object.freeze({
      ...base,
      effective: reported,
      reasons: Object.freeze(
        pressureReasons === undefined
          ? [`pressure_${pressureMode}`]
          : [...pressureReasons],
      ),
      recoveryReserved: reserve,
      status: "producer_paused",
    });
  }
  if (pressureMode === "derated") {
    return Object.freeze({
      ...base,
      effective: scaled(
        reported,
        node.hostPressureState?.derateFactor ?? policy.softPressureFactor,
      ),
      reasons: Object.freeze(
        pressureReasons === undefined
          ? ["pressure_derated"]
          : [...pressureReasons],
      ),
      recoveryReserved: reserve,
      status: "derated",
    });
  }
  return Object.freeze({
    ...base,
    effective: reported,
    reasons: Object.freeze([]),
    recoveryReserved: reserve,
    status: "open",
  });
}

export function laneCapacity(
  snapshot: DerivedCapacitySnapshot,
  lane: AdmissionLane,
  recoveryQueued: boolean,
): ResourceAmounts {
  if (snapshot.status.startsWith("closed_")) return zero(snapshot.effective);
  if (lane === "producer" && snapshot.status === "producer_paused") {
    return zero(snapshot.effective);
  }
  if (lane === "recovery") return snapshot.effective;
  if (!recoveryQueued) return snapshot.effective;
  const values: Record<string, number> = {};
  for (const [dimension, amount] of Object.entries(snapshot.effective)) {
    values[dimension] = Math.max(
      0,
      amount - (snapshot.recoveryReserved[dimension] ?? 0),
    );
  }
  return Object.freeze(values);
}

export function evaluateSafetyBounds(
  bounds: SafetyBounds,
): SafetyBoundDecision {
  if (
    Object.values(bounds).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  ) {
    throw new Error("invalid_safety_bounds");
  }
  const reasons: string[] = [];
  if (bounds.backlogCount >= bounds.hardBacklogCount)
    reasons.push("hard_backlog_count");
  if (bounds.backlogBytes >= bounds.hardBacklogBytes)
    reasons.push("hard_backlog_bytes");
  if (bounds.diskAvailableBytes <= bounds.minimumDiskReserveBytes)
    reasons.push("hard_disk_reserve");
  if (bounds.recoveryDebt >= bounds.hardRecoveryDebt)
    reasons.push("hard_recovery_debt");
  return reasons.length === 0
    ? Object.freeze({ reasons: Object.freeze([]), status: "open" })
    : Object.freeze({ reasons: Object.freeze(reasons), status: "closed" });
}

export function fitsResources(
  request: ResourceAmounts,
  capacity: ResourceAmounts,
): boolean {
  return Object.entries(request).every(
    ([dimension, amount]) =>
      amount >= 0 && amount <= (capacity[dimension] ?? 0),
  );
}

export function subtractResources(
  capacity: ResourceAmounts,
  used: ResourceAmounts,
): ResourceAmounts {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(capacity).map(([dimension, amount]) => [
        dimension,
        Math.max(0, amount - (used[dimension] ?? 0)),
      ]),
    ),
  );
}
