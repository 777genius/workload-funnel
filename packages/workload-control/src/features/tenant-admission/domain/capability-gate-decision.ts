import type { CapabilityName } from "./capability-requirement.js";

export type CapabilityGateDecision =
  | Readonly<{
      capability: CapabilityName;
      evidenceIds: readonly string[];
      status: "pass";
    }>
  | Readonly<{
      capability: CapabilityName;
      evidenceIds: readonly string[];
      reasonCode: string;
      status: "unsupported";
    }>;

function freezeEvidenceIds(evidenceIds: readonly string[]): readonly string[] {
  return Object.freeze([...evidenceIds]);
}

export function passCapabilityGate(
  capability: CapabilityName,
  evidenceIds: readonly string[],
): CapabilityGateDecision {
  return Object.freeze({
    capability,
    evidenceIds: freezeEvidenceIds(evidenceIds),
    status: "pass",
  });
}

export function markCapabilityUnsupported(
  capability: CapabilityName,
  reasonCode: string,
  evidenceIds: readonly string[],
): CapabilityGateDecision {
  if (reasonCode.length === 0) {
    throw new Error("Unsupported capability requires a stable reason code");
  }

  return Object.freeze({
    capability,
    evidenceIds: freezeEvidenceIds(evidenceIds),
    reasonCode,
    status: "unsupported",
  });
}

export function supportedCapabilityNames(
  decisions: readonly CapabilityGateDecision[],
): ReadonlySet<CapabilityName> {
  const unsupported = new Set(
    decisions
      .filter((decision) => decision.status === "unsupported")
      .map((decision) => decision.capability),
  );
  return new Set(
    decisions
      .filter(
        (decision) =>
          decision.status === "pass" && !unsupported.has(decision.capability),
      )
      .map((decision) => decision.capability),
  );
}
