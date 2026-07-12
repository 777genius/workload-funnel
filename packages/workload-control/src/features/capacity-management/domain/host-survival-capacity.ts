import type { NodeSnapshot } from "@workload-funnel/workload-control/node-lifecycle";

export interface HostSurvivalAdmissionDecision {
  readonly controlOperations: Readonly<{
    readonly breakGlassStop: true;
    readonly cancellation: true;
    readonly observation: true;
  }>;
  readonly producerAdmission: "derated" | "open" | "paused";
  readonly producerFactor: number;
  readonly recoveryAdmission: "open";
  readonly reasons: readonly string[];
}

export function deriveHostSurvivalAdmission(
  node: NodeSnapshot,
): HostSurvivalAdmissionDecision {
  const pressure = node.hostPressureState;
  if (pressure === undefined || node.hostSurvivalProfileBinding === undefined) {
    throw new Error("canonical_host_survival_observation_missing");
  }
  return Object.freeze({
    controlOperations: Object.freeze({
      breakGlassStop: true,
      cancellation: true,
      observation: true,
    }),
    producerAdmission:
      pressure.mode === "healthy"
        ? "open"
        : pressure.mode === "derated"
          ? "derated"
          : "paused",
    producerFactor: pressure.derateFactor,
    recoveryAdmission: "open",
    reasons: Object.freeze([...pressure.reasons]),
  });
}
