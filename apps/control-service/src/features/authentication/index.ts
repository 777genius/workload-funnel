export {
  authenticateSyntheticToken,
  AuthenticationError,
  type SyntheticTransportIdentity,
} from "./domain/synthetic-authentication.js";
export {
  bearerTokenDigest,
  createTransportAuthenticator,
  TransportAuthenticationError,
  type AuthenticatedTransportIdentity,
  type TransportAuthenticator,
  type TransportCredential,
  type TransportIdentityBinding,
} from "./api/transport-authentication.js";
export {
  createDurableServiceIdentityAuthority,
  serviceEnrollmentProofDigest,
  signServiceIdentityActor,
  type DurableServiceIdentityAuthority,
} from "./application/durable-service-identity-authority.js";
export type {
  ServiceIdentityAuthorityStore,
  ServiceIdentityAuthorityStoreCapabilities,
} from "./application/contracts/service-identity-authority-store.js";
export {
  ServiceIdentityAuthorityError,
  type AuthenticatedServicePrincipal,
  type NodeMessageReplayCursor,
  type NodePublicationPermission,
  type ServiceCredentialBinding,
  type ServiceIdentityActor,
  type ServiceIdentityAuthorizationEvidence,
  type ServiceIdentityKind,
  type ServiceIdentityOperationReceipt,
  type ServiceIdentityRecord,
  type ServiceIdentityState,
} from "./domain/service-identity.js";
