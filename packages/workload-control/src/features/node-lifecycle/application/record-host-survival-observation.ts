import { recordVerifiedHostSurvivalObservation } from "../domain/host-survival-observation.js";
import type {
  HostPressureHysteresisPolicy,
  HostPressureObservation,
} from "../domain/host-pressure-hysteresis.js";
import type {
  NodeSnapshot,
  VerifiedHostSurvivalProfileBinding,
} from "../domain/node-snapshot.js";
import { fingerprintHostPressurePolicy } from "./host-pressure-policy-fingerprint.js";

export interface HostSurvivalProfilePressureBinding {
  readonly pressurePolicyBinding: Readonly<{
    readonly digest: string;
    readonly policyId: string;
    readonly revision: number;
  }>;
  readonly profileId: string;
  readonly revision: number;
  readonly schemaVersion: "phase4c.host-survival-profile.v1";
}

function verifyBinding(
  profile: HostSurvivalProfilePressureBinding,
  policy: HostPressureHysteresisPolicy,
): VerifiedHostSurvivalProfileBinding {
  const schemaVersion: unknown = profile.schemaVersion;
  if (
    schemaVersion !== "phase4c.host-survival-profile.v1" ||
    !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(profile.profileId) ||
    !Number.isSafeInteger(profile.revision) ||
    profile.revision < 1
  ) {
    throw new Error("invalid_host_survival_profile_binding");
  }
  const expectedDigest = fingerprintHostPressurePolicy(policy);
  if (
    profile.pressurePolicyBinding.policyId !== policy.policyId ||
    profile.pressurePolicyBinding.revision !== policy.revision ||
    profile.pressurePolicyBinding.digest !== expectedDigest
  ) {
    throw new Error("host_pressure_policy_fingerprint_mismatch");
  }
  return Object.freeze({
    policyDigest: expectedDigest,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    profileId: profile.profileId,
    profileRevision: profile.revision,
  });
}

export function recordHostSurvivalObservation(
  node: NodeSnapshot,
  expectedVersion: number,
  observation: HostPressureObservation,
  profile: HostSurvivalProfilePressureBinding,
  policy: HostPressureHysteresisPolicy,
  now: number,
): NodeSnapshot {
  const binding = verifyBinding(profile, policy);
  return recordVerifiedHostSurvivalObservation(
    node,
    expectedVersion,
    observation,
    policy,
    binding,
    now,
  );
}
