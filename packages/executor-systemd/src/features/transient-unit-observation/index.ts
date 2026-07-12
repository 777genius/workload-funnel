export type TransientUnitState = "active" | "failed" | "inactive" | "unknown";

export interface TransientUnitObservationManager {
  readonly transientServiceObservation: "supported" | "unsupported";
  observeTransientService(unitName: string): TransientUnitState;
}

export type TransientUnitObservationResult =
  | {
      readonly state: TransientUnitState;
      readonly status: "observed";
      readonly unitName: string;
    }
  | {
      readonly evidence: "systemd_transient_service_observation_unsupported";
      readonly status: "unsupported";
    };

export function observeSyntheticTransientUnit(
  manager: TransientUnitObservationManager,
  unitName: string,
): TransientUnitObservationResult {
  if (manager.transientServiceObservation !== "supported") {
    return {
      evidence: "systemd_transient_service_observation_unsupported",
      status: "unsupported",
    };
  }
  return {
    state: manager.observeTransientService(unitName),
    status: "observed",
    unitName,
  };
}
