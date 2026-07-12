import { createHash } from "node:crypto";

import type { HostPressureHysteresisPolicy } from "../domain/host-pressure-hysteresis.js";

export function fingerprintHostPressurePolicy(
  policy: HostPressureHysteresisPolicy,
): string {
  const canonical = {
    healthyObservationsToRecover: policy.healthyObservationsToRecover,
    highObservationsToPause: policy.highObservationsToPause,
    maximumObservationAgeMs: policy.maximumObservationAgeMs,
    policyId: policy.policyId,
    revision: policy.revision,
    softDerateFactor: policy.softDerateFactor,
    thresholds: Object.fromEntries(
      Object.entries(policy.thresholds).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}
