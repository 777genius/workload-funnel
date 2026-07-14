export type ServiceIdentityKind =
  | "control-service"
  | "node-agent"
  | "node-launcher"
  | "result-sealer"
  | "runtime-broker"
  | "scheduler-gateway";

export type ServiceIdentityState =
  | "pending"
  | "active"
  | "quarantined"
  | "revoked";

export type NodePublicationPermission =
  | "node.capacity.publish"
  | "node.result.publish";

export interface ServiceCredentialBinding {
  readonly credentialId: string;
  readonly certificateFingerprint: string;
  readonly certificateSerial: string;
  readonly generation: number;
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly revokedAt?: number;
}

export interface ServiceIdentityRecord {
  readonly identityId: string;
  readonly kind: ServiceIdentityKind;
  readonly audience: string;
  readonly nodeId?: string;
  readonly state: ServiceIdentityState;
  readonly enrollmentProofDigest: string;
  readonly enrollmentActorPrincipalId?: string;
  readonly enrollmentAuthorizationEvidenceDigest?: string;
  readonly enrollmentCredentialFingerprint?: string;
  readonly permissions: readonly NodePublicationPermission[];
  readonly credentials: readonly ServiceCredentialBinding[];
  readonly currentCredentialId?: string;
  readonly currentBootEpoch?: string;
  readonly bootEpochGeneration: number;
  readonly revocationRevision: number;
  readonly quarantineReason?: string;
  readonly version: number;
}

export interface ServiceIdentityAuthorizationEvidence {
  readonly audience: string;
  readonly authenticationMethod: "mtls" | "unix-peer";
  readonly authorizationDecisionId: string;
  readonly evidenceDigest: string;
  readonly authenticatedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
  readonly boundNodeId?: string;
  readonly boundCredentialFingerprint?: string;
}

export interface ServiceIdentityActor {
  readonly principalId: string;
  readonly permissions: ReadonlySet<
    | "service_identity.enroll"
    | "service_identity.approve"
    | "service_identity.rotate"
    | "service_identity.revoke"
    | "service_identity.quarantine"
    | "service_identity.boot_epoch"
  >;
  readonly evidence: ServiceIdentityAuthorizationEvidence;
}

export interface ServiceIdentityOperationReceipt {
  readonly operationId: string;
  readonly operationFingerprint: string;
  readonly identityId: string;
  readonly identityVersion: number;
  readonly actorPrincipalId: string;
  readonly authorizationEvidenceDigest: string;
  readonly outcome:
    | "enrollment_requested"
    | "enrollment_approved"
    | "credential_rotated"
    | "identity_revoked"
    | "identity_quarantined"
    | "boot_epoch_advanced";
}

export interface NodeMessageReplayCursor {
  readonly credentialId: string;
  readonly nodeId: string;
  readonly bootEpoch: string;
  readonly highestSourceSequence: number;
  readonly recentNonces: readonly string[];
  readonly version: number;
}

export interface AuthenticatedServicePrincipal {
  readonly principalId: string;
  readonly identityId: string;
  readonly identityKind: ServiceIdentityKind;
  readonly credentialId: string;
  readonly audience: string;
  readonly authenticatedAt: number;
  readonly nodeId?: string;
  readonly bootEpoch?: string;
  readonly sourceSequence?: number;
  readonly authorizedPublication?: NodePublicationPermission;
}

export class ServiceIdentityAuthorityError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ServiceIdentityAuthorityError";
  }
}

export function assertServiceIdentityText(value: string, field: string): void {
  if (
    value.length < 1 ||
    value.length > 512 ||
    value !== value.normalize("NFC") ||
    /\p{Cc}/u.test(value)
  )
    throw new ServiceIdentityAuthorityError(`invalid_${field}`);
}

export function assertServiceIdentityRevision(
  value: number,
  field: string,
): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ServiceIdentityAuthorityError(`invalid_${field}`);
}

export function freezeServiceIdentity(
  identity: ServiceIdentityRecord,
): ServiceIdentityRecord {
  return Object.freeze({
    ...identity,
    credentials: Object.freeze(
      identity.credentials.map((credential) =>
        Object.freeze({ ...credential }),
      ),
    ),
    permissions: Object.freeze([...identity.permissions]),
  });
}
