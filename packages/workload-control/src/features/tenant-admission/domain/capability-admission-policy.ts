import type {
  CapabilityRequirement,
  CapabilityName,
} from "./capability-requirement.js";

export type CapabilityAdmissionDecision =
  | Readonly<{
      status: "satisfied";
    }>
  | Readonly<{
      missingCapabilities: readonly CapabilityName[];
      status: "unschedulable_missing_capability";
    }>;

export function decideCapabilityAdmission(
  required: readonly CapabilityRequirement[],
  available: ReadonlySet<CapabilityName>,
): CapabilityAdmissionDecision {
  const missingCapabilities = [
    ...new Set(
      required
        .map((requirement) => requirement.name)
        .filter((name) => !available.has(name)),
    ),
  ].sort();

  if (missingCapabilities.length === 0) {
    return Object.freeze({ status: "satisfied" });
  }

  return Object.freeze({
    missingCapabilities: Object.freeze(missingCapabilities),
    status: "unschedulable_missing_capability",
  });
}
