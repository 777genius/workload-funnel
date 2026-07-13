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
