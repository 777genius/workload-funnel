export {
  HOST_SURVIVAL_PROFILE_SCHEMA,
  evaluateStorageHeadroom,
  validateHostSurvivalProfile,
  type HostSurvivalProfile,
  type ProtectedSliceControls,
  type StorageHeadroom,
  type StorageHeadroomDecision,
  type StorageHeadroomObservation,
  type StorageHeadroomClass,
  type WorkloadSliceControls,
} from "./domain/host-survival-profile.js";
export {
  RESOURCE_CONTROL_SCHEMA,
  InvalidResourceControlProfileError,
  validateResourceControlGrant,
  type CpuResourceGrant,
  type EphemeralStorageGrant,
  type IoDeviceLimit,
  type IoResourceGrant,
  type MemorySwapGrant,
  type MemoryResourceGrant,
  type ResourceControlGrant,
  type ResourceEnforcementCapability,
  type ResourceEnforcementCapabilityReport,
} from "./domain/resource-controls.js";
export {
  SANDBOX_PROFILE_SCHEMA,
  requiredSandboxCapabilities,
  validateSandboxProfile,
  type SandboxIsolationPolicy,
  type SandboxProfile,
} from "./domain/sandbox-profile.js";
export { fingerprintSandboxProfile } from "./application/sandbox-profile-fingerprint.js";
