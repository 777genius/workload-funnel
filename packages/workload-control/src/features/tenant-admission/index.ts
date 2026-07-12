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
