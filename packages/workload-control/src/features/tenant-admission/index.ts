export {
  CapabilityRequirement,
  InvalidCapabilityRequirementError,
  type CapabilityName,
} from "./domain/capability-requirement.js";
export {
  markCapabilityUnsupported,
  passCapabilityGate,
  supportedCapabilityNames,
  type CapabilityGateDecision,
} from "./domain/capability-gate-decision.js";
export {
  decideCapabilityAdmission,
  type CapabilityAdmissionDecision,
} from "./domain/capability-admission-policy.js";
export {
  createCapabilityRequirementEvaluator,
  type EvaluateCapabilityRequirements,
} from "./application/evaluate-capability-requirements.js";
export { createTenantAdmissionTransactionParticipant } from "./application/transaction-participant.js";
export {
  selectFairAdmission,
  type AdmissionCapacityCandidate,
  type AdmissionExplanation,
  type AdmissionPlan,
  type AdmissionPolicy,
  type AdmissionReasonCode,
  type AdmissionSelection,
  type FairnessChargeSnapshot,
  type QueuedWorkload,
  type TenantFairnessPolicy,
  type WorkloadClassPolicy,
  type WorkloadLane,
} from "./domain/fair-admission.js";
export {
  SerializedFairnessLedger,
  StaleFairnessDecisionError,
  recordQueueBypasses,
} from "./domain/fairness-ledger.js";
export {
  AdmissionExplanationGapError,
  AdmissionExplanationView,
  type AdmissionExplanationProjection,
} from "./application/admission-explanation-view.js";
