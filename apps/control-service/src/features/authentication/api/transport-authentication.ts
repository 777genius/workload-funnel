import { createHash, timingSafeEqual } from "node:crypto";

export type TransportCredential =
  | Readonly<{ kind: "bearer"; token: string }>
  | Readonly<{
      kind: "verified-unix-peer";
      uid: number;
      gid: number;
      pid: number;
    }>
  | Readonly<{
      kind: "verified-mtls";
      certificateFingerprint: string;
    }>;

export interface AuthenticatedTransportIdentity {
  readonly principalId: string;
  readonly identityKind: TransportCredential["kind"];
  readonly credentialId: string;
  readonly authenticatedAt: number;
}

export interface TransportIdentityBinding {
  readonly principalId: string;
  readonly credentialId: string;
  readonly bearerTokenSha256?: string;
  readonly unixUid?: number;
  readonly certificateFingerprint?: string;
  readonly disabled?: boolean;
}

export interface TransportAuthenticator {
  authenticate(
    credential: TransportCredential,
    now: number,
  ): AuthenticatedTransportIdentity;
}

export class TransportAuthenticationError extends Error {
  public readonly code = "unauthenticated";

  public constructor() {
    super("transport_authentication_failed");
    this.name = "TransportAuthenticationError";
  }
}

function equalText(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function bindingMatches(
  binding: TransportIdentityBinding,
  credential: TransportCredential,
): boolean {
  if (binding.disabled === true) return false;
  switch (credential.kind) {
    case "bearer": {
      if (
        binding.bearerTokenSha256 === undefined ||
        credential.token.length < 1 ||
        credential.token.length > 16_384
      )
        return false;
      const digest = createHash("sha256")
        .update(credential.token, "utf8")
        .digest("hex");
      return equalText(digest, binding.bearerTokenSha256);
    }
    case "verified-mtls":
      return (
        binding.certificateFingerprint !== undefined &&
        credential.certificateFingerprint.length > 0 &&
        credential.certificateFingerprint.length <= 512 &&
        equalText(
          credential.certificateFingerprint,
          binding.certificateFingerprint,
        )
      );
    case "verified-unix-peer":
      return (
        Number.isSafeInteger(credential.uid) &&
        credential.uid >= 0 &&
        Number.isSafeInteger(credential.gid) &&
        credential.gid >= 0 &&
        Number.isSafeInteger(credential.pid) &&
        credential.pid > 0 &&
        binding.unixUid === credential.uid
      );
  }
}

export function bearerTokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createTransportAuthenticator(
  bindings: readonly TransportIdentityBinding[],
): TransportAuthenticator {
  const boundedIdentity = (value: string): boolean =>
    value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
  const bindingIdentities = new Set<string>();
  const credentialIds = new Set<string>();
  for (const binding of bindings) {
    const mechanisms = [
      binding.bearerTokenSha256 === undefined
        ? undefined
        : `bearer:${binding.bearerTokenSha256}`,
      binding.unixUid === undefined
        ? undefined
        : `unix:${String(binding.unixUid)}`,
      binding.certificateFingerprint === undefined
        ? undefined
        : `mtls:${binding.certificateFingerprint}`,
    ].filter((value): value is string => value !== undefined);
    if (
      !boundedIdentity(binding.principalId) ||
      !boundedIdentity(binding.credentialId) ||
      mechanisms.length !== 1 ||
      (binding.bearerTokenSha256 !== undefined &&
        !/^[a-f0-9]{64}$/u.test(binding.bearerTokenSha256)) ||
      (binding.unixUid !== undefined &&
        (!Number.isSafeInteger(binding.unixUid) || binding.unixUid < 0)) ||
      (binding.certificateFingerprint !== undefined &&
        (binding.certificateFingerprint.length < 1 ||
          binding.certificateFingerprint.length > 512 ||
          /\p{Cc}/u.test(binding.certificateFingerprint))) ||
      credentialIds.has(binding.credentialId) ||
      mechanisms.some((mechanism) => bindingIdentities.has(mechanism))
    )
      throw new Error("invalid_transport_identity_binding");
    credentialIds.add(binding.credentialId);
    for (const mechanism of mechanisms) bindingIdentities.add(mechanism);
  }
  const stableBindings = Object.freeze(bindings.map((item) => ({ ...item })));
  const authenticator: TransportAuthenticator = {
    authenticate(credential, now) {
      if (!Number.isSafeInteger(now) || now < 0)
        throw new TransportAuthenticationError();
      const binding = stableBindings.find((item) =>
        bindingMatches(item, credential),
      );
      if (binding === undefined) throw new TransportAuthenticationError();
      return Object.freeze({
        authenticatedAt: now,
        credentialId: binding.credentialId,
        identityKind: credential.kind,
        principalId: binding.principalId,
      });
    },
  };
  return Object.freeze(authenticator);
}
