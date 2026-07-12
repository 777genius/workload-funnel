export {
  createCapacityManagementTransactionParticipant,
  deriveStaticCapacity,
  type StaticCapacityProfile,
} from "./application/static-capacity.js";
export {
  deriveAdmissionCapacity,
  evaluateSafetyBounds,
  fitsResources,
  laneCapacity,
  subtractResources,
  type AdmissionLane,
  type CapacityDerivationPolicy,
  type DerivedCapacitySnapshot,
  type ResourceAmounts,
  type SafetyBoundDecision,
  type SafetyBounds,
} from "./domain/resource-capacity.js";
export {
  deriveHostSurvivalAdmission,
  type HostSurvivalAdmissionDecision,
} from "./domain/host-survival-capacity.js";
