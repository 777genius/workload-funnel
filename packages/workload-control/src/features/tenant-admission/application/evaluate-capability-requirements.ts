import {
  CapabilityRequirement,
  type CapabilityName,
} from "../domain/capability-requirement.js";
import {
  decideCapabilityAdmission,
  type CapabilityAdmissionDecision,
} from "../domain/capability-admission-policy.js";

export type EvaluateCapabilityRequirements = (
  requiredCapabilities: readonly CapabilityName[],
) => CapabilityAdmissionDecision;

export function createCapabilityRequirementEvaluator(
  availableCapabilities: readonly CapabilityName[],
): EvaluateCapabilityRequirements {
  const available = new Set(
    availableCapabilities.map((name) => CapabilityRequirement.from(name).name),
  );

  return (requiredCapabilities) =>
    decideCapabilityAdmission(
      requiredCapabilities.map((name) => CapabilityRequirement.from(name)),
      available,
    );
}
