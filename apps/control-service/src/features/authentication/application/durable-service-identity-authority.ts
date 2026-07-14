import {
  createHash,
  sign as createSignature,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import type { ServiceIdentityAuthorityStore } from "./contracts/service-identity-authority-store.js";
import {
  assertServiceIdentityRevision,
  assertServiceIdentityText,
  freezeServiceIdentity,
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
} from "../domain/service-identity.js";

const maximumCredentialLifetimeMs = 24 * 60 * 60 * 1000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value instanceof Set)
    return `[${[...value].map(canonical).sort().join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(input: unknown): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

function actorSignaturePayload(
  actor: Readonly<{
    principalId: string;
    permissions: ReadonlySet<string>;
    evidence: Omit<ServiceIdentityAuthorizationEvidence, "signatureBase64Url">;
  }>,
): unknown {
  return Object.freeze({
    evidence: actor.evidence,
    permissions: Object.freeze([...actor.permissions].sort()),
    principalId: actor.principalId,
  });
}

export function signServiceIdentityActor(
  actor: Readonly<{
    principalId: string;
    permissions: ServiceIdentityActor["permissions"];
    evidence: Omit<ServiceIdentityAuthorizationEvidence, "signatureBase64Url">;
  }>,
  privateKey: KeyObject,
): ServiceIdentityActor {
  return Object.freeze({
    ...actor,
    evidence: Object.freeze({
      ...actor.evidence,
      signatureBase64Url: createSignature(
        null,
        Buffer.from(canonical(actorSignaturePayload(actor))),
        privateKey,
      ).toString("base64url"),
    }),
  });
}

export function serviceEnrollmentProofDigest(
  input: Readonly<{
    actor: ServiceIdentityActor;
    identityId: string;
    nodeId: string;
  }>,
): string {
  return fingerprint({
    authorizationDecisionId: input.actor.evidence.authorizationDecisionId,
    boundCredentialFingerprint:
      input.actor.evidence.boundCredentialFingerprint ?? null,
    boundNodeId: input.actor.evidence.boundNodeId ?? null,
    evidenceDigest: input.actor.evidence.evidenceDigest,
    identityId: input.identityId,
    nodeId: input.nodeId,
    principalId: input.actor.principalId,
  });
}

function requirePermission(
  actor: ServiceIdentityActor,
  permission: ServiceIdentityActor["permissions"] extends ReadonlySet<infer T>
    ? T
    : never,
  now: number,
  trustedActorKeys: ReadonlyMap<string, KeyObject>,
): void {
  assertServiceIdentityText(actor.principalId, "actor_principal_id");
  assertServiceIdentityText(
    actor.evidence.authorizationDecisionId,
    "authorization_decision_id",
  );
  assertServiceIdentityText(actor.evidence.nonce, "authorization_nonce");
  assertServiceIdentityText(actor.evidence.signerKeyId, "authorization_signer");
  assertServiceIdentityRevision(
    actor.evidence.authenticatedAt,
    "actor_authenticated_at",
  );
  assertServiceIdentityRevision(actor.evidence.expiresAt, "actor_expires_at");
  const actorKey = trustedActorKeys.get(actor.evidence.signerKeyId);
  const { signatureBase64Url: _signature, ...unsignedEvidence } =
    actor.evidence;
  if (
    actor.evidence.audience !== "workload-funnel-service-identity" ||
    !["mtls", "unix-peer"].includes(actor.evidence.authenticationMethod) ||
    !/^[a-f0-9]{64}$/u.test(actor.evidence.evidenceDigest) ||
    now < actor.evidence.authenticatedAt ||
    now >= actor.evidence.expiresAt ||
    actor.evidence.expiresAt - actor.evidence.authenticatedAt > 5 * 60 * 1000 ||
    !actor.permissions.has(permission) ||
    actorKey === undefined ||
    !verifySignature(
      null,
      Buffer.from(
        canonical(
          actorSignaturePayload({
            evidence: unsignedEvidence,
            permissions: actor.permissions,
            principalId: actor.principalId,
          }),
        ),
      ),
      actorKey,
      Buffer.from(_signature, "base64url"),
    )
  )
    throw new ServiceIdentityAuthorityError("service_identity_forbidden");
}

function assertOperation(operationId: string): void {
  assertServiceIdentityText(operationId, "operation_id");
}

function receipt(
  operationId: string,
  operationFingerprint: string,
  identity: ServiceIdentityRecord,
  outcome: ServiceIdentityOperationReceipt["outcome"],
  actor: ServiceIdentityActor,
): ServiceIdentityOperationReceipt {
  return Object.freeze({
    actorPrincipalId: actor.principalId,
    authorizationEvidenceDigest: actor.evidence.evidenceDigest,
    identityId: identity.identityId,
    identityVersion: identity.version,
    operationFingerprint,
    operationId,
    outcome,
  });
}

function exactReplay(
  store: ServiceIdentityAuthorityStore,
  operationId: string,
  operationFingerprint: string,
): ServiceIdentityRecord | undefined {
  const prior = store.getOperation(operationId);
  if (prior === undefined) return undefined;
  if (prior.operationFingerprint !== operationFingerprint)
    throw new ServiceIdentityAuthorityError(
      "identity_operation_replay_conflict",
    );
  const identity = store.get(prior.identityId);
  if (identity === undefined || identity.version < prior.identityVersion)
    throw new ServiceIdentityAuthorityError("identity_authority_state_corrupt");
  return identity;
}

function assertCredentialInput(
  input: Readonly<{
    credentialId: string;
    certificateFingerprint: string;
    certificateSerial: string;
    issuedAt: number;
    notAfter: number;
  }>,
): void {
  assertServiceIdentityText(input.credentialId, "credential_id");
  assertServiceIdentityText(
    input.certificateFingerprint,
    "certificate_fingerprint",
  );
  assertServiceIdentityText(input.certificateSerial, "certificate_serial");
  assertServiceIdentityRevision(input.issuedAt, "credential_issued_at");
  assertServiceIdentityRevision(input.notAfter, "credential_not_after");
  if (
    input.notAfter <= input.issuedAt ||
    input.notAfter - input.issuedAt > maximumCredentialLifetimeMs
  )
    throw new ServiceIdentityAuthorityError("credential_lifetime_unsafe");
}

export interface DurableServiceIdentityAuthority {
  requestEnrollment(
    input: Readonly<{
      operationId: string;
      identityId: string;
      kind: ServiceIdentityKind;
      audience: string;
      nodeId?: string;
      enrollmentProofDigest: string;
      actor: ServiceIdentityActor;
    }>,
  ): ServiceIdentityRecord;
  approveEnrollment(
    input: Readonly<{
      operationId: string;
      identityId: string;
      expectedVersion: number;
      actor: ServiceIdentityActor;
      credentialId: string;
      certificateFingerprint: string;
      certificateSerial: string;
      issuedAt: number;
      notAfter: number;
      permissions: readonly NodePublicationPermission[];
    }>,
  ): ServiceIdentityRecord;
  rotateCredential(
    input: Readonly<{
      operationId: string;
      identityId: string;
      expectedVersion: number;
      actor: ServiceIdentityActor;
      credentialId: string;
      certificateFingerprint: string;
      certificateSerial: string;
      issuedAt: number;
      notAfter: number;
    }>,
  ): ServiceIdentityRecord;
  revoke(
    input: Readonly<{
      operationId: string;
      identityId: string;
      expectedVersion: number;
      actor: ServiceIdentityActor;
      revokedAt: number;
    }>,
  ): ServiceIdentityRecord;
  quarantine(
    input: Readonly<{
      operationId: string;
      identityId: string;
      expectedVersion: number;
      actor: ServiceIdentityActor;
      reason: string;
    }>,
  ): ServiceIdentityRecord;
  advanceNodeBootEpoch(
    input: Readonly<{
      operationId: string;
      identityId: string;
      expectedVersion: number;
      actor: ServiceIdentityActor;
    }>,
  ): ServiceIdentityRecord;
  authenticate(
    input: Readonly<{
      identityId: string;
      credentialId: string;
      certificateFingerprint: string;
      certificateSerial: string;
      audience: string;
      now: number;
      nodeId?: string;
    }>,
  ): AuthenticatedServicePrincipal;
  authorizeNodeMessage(
    input: Readonly<{
      identityId: string;
      credentialId: string;
      certificateFingerprint: string;
      certificateSerial: string;
      audience: string;
      now: number;
      nodeId: string;
      bootEpoch: string;
      sourceSequence: number;
      nonce: string;
      publication: NodePublicationPermission;
    }>,
  ): AuthenticatedServicePrincipal;
}

export function createDurableServiceIdentityAuthority(
  store: ServiceIdentityAuthorityStore,
  options: Readonly<{
    nowMs?: () => number;
    trustedActorKeys: ReadonlyMap<string, KeyObject>;
  }>,
): DurableServiceIdentityAuthority {
  const nowMs = options.nowMs ?? Date.now;
  if (
    !store.capabilities.authenticatedWrites ||
    !store.capabilities.compareAndSet ||
    !store.capabilities.durable ||
    !store.capabilities.multiWriter
  )
    throw new ServiceIdentityAuthorityError("identity_authority_incapable");

  function active(identityId: string): ServiceIdentityRecord {
    const identity = store.get(identityId);
    if (identity === undefined)
      throw new ServiceIdentityAuthorityError("identity_not_enrolled");
    if (identity.state !== "active")
      throw new ServiceIdentityAuthorityError("identity_not_active");
    return identity;
  }

  function approvedPermissions(
    kind: ServiceIdentityKind,
    permissions: readonly NodePublicationPermission[],
  ): readonly NodePublicationPermission[] {
    const approved = [...new Set(permissions)].sort();
    const nodePermissions: readonly NodePublicationPermission[] = [
      "node.capacity.publish",
      "node.result.publish",
    ];
    if (
      approved.length !== permissions.length ||
      approved.some((permission) => !nodePermissions.includes(permission)) ||
      (kind === "node-agent" && approved.length < 1) ||
      (kind !== "node-agent" && approved.length > 0)
    )
      throw new ServiceIdentityAuthorityError(
        "service_identity_permission_invalid",
      );
    return Object.freeze(approved);
  }

  function authenticate(
    input: Readonly<{
      identityId: string;
      credentialId: string;
      certificateFingerprint: string;
      certificateSerial: string;
      audience: string;
      now: number;
      nodeId?: string;
    }>,
  ): AuthenticatedServicePrincipal {
    assertServiceIdentityRevision(input.now, "authentication_time");
    const identity = active(input.identityId);
    const credential = identity.credentials.find(
      (candidate) => candidate.credentialId === input.credentialId,
    );
    if (
      credential === undefined ||
      identity.currentCredentialId !== credential.credentialId ||
      credential.revokedAt !== undefined ||
      input.now < credential.issuedAt ||
      input.now >= credential.notAfter ||
      credential.certificateFingerprint !== input.certificateFingerprint ||
      credential.certificateSerial !== input.certificateSerial ||
      identity.audience !== input.audience ||
      identity.nodeId !== input.nodeId
    )
      throw new ServiceIdentityAuthorityError(
        "service_identity_authentication_failed",
      );
    return Object.freeze({
      audience: identity.audience,
      authenticatedAt: input.now,
      credentialId: credential.credentialId,
      identityId: identity.identityId,
      identityKind: identity.kind,
      ...(identity.nodeId === undefined ? {} : { nodeId: identity.nodeId }),
      principalId: `service:${identity.identityId}`,
    });
  }

  function change(
    input: Readonly<{
      operationId: string;
      operationFingerprint: string;
      expectedVersion: number;
      current: ServiceIdentityRecord;
      next: ServiceIdentityRecord;
      outcome: ServiceIdentityOperationReceipt["outcome"];
      actor: ServiceIdentityActor;
    }>,
  ): ServiceIdentityRecord {
    const replay = exactReplay(
      store,
      input.operationId,
      input.operationFingerprint,
    );
    if (replay !== undefined) return replay;
    if (input.current.version !== input.expectedVersion)
      throw new ServiceIdentityAuthorityError("identity_version_conflict");
    return store.compareAndSet(
      input.expectedVersion,
      input.next,
      receipt(
        input.operationId,
        input.operationFingerprint,
        input.next,
        input.outcome,
        input.actor,
      ),
    );
  }

  const authority: DurableServiceIdentityAuthority = {
    requestEnrollment(input) {
      const now = nowMs();
      requirePermission(
        input.actor,
        "service_identity.enroll",
        now,
        options.trustedActorKeys,
      );
      assertOperation(input.operationId);
      assertServiceIdentityText(input.identityId, "identity_id");
      assertServiceIdentityText(input.audience, "identity_audience");
      assertServiceIdentityText(
        input.enrollmentProofDigest,
        "enrollment_proof_digest",
      );
      if (input.kind === "node-agent" && input.nodeId === undefined)
        throw new ServiceIdentityAuthorityError(
          "node_identity_binding_required",
        );
      if (input.kind !== "node-agent" && input.nodeId !== undefined)
        throw new ServiceIdentityAuthorityError(
          "unexpected_node_identity_binding",
        );
      if (input.nodeId !== undefined)
        assertServiceIdentityText(input.nodeId, "node_id");
      if (
        input.nodeId !== undefined &&
        (input.actor.evidence.boundNodeId !== input.nodeId ||
          input.actor.evidence.boundCredentialFingerprint === undefined ||
          input.enrollmentProofDigest !==
            serviceEnrollmentProofDigest({
              actor: input.actor,
              identityId: input.identityId,
              nodeId: input.nodeId,
            }))
      )
        throw new ServiceIdentityAuthorityError(
          "node_enrollment_actor_binding_invalid",
        );
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const identity = freezeServiceIdentity({
        audience: input.audience,
        bootEpochGeneration: 0,
        credentials: Object.freeze([]),
        enrollmentProofDigest: input.enrollmentProofDigest,
        enrollmentActorPrincipalId: input.actor.principalId,
        enrollmentAuthorizationEvidenceDigest:
          input.actor.evidence.evidenceDigest,
        ...(input.actor.evidence.boundCredentialFingerprint === undefined
          ? {}
          : {
              enrollmentCredentialFingerprint:
                input.actor.evidence.boundCredentialFingerprint,
            }),
        identityId: input.identityId,
        kind: input.kind,
        permissions: Object.freeze([]),
        ...(input.nodeId === undefined ? {} : { nodeId: input.nodeId }),
        revocationRevision: 0,
        state: "pending",
        version: 1,
      });
      return store.create(
        identity,
        receipt(
          input.operationId,
          operationFingerprint,
          identity,
          "enrollment_requested",
          input.actor,
        ),
      );
    },
    approveEnrollment(input) {
      requirePermission(
        input.actor,
        "service_identity.approve",
        nowMs(),
        options.trustedActorKeys,
      );
      assertCredentialInput(input);
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const current = store.get(input.identityId);
      if (current === undefined)
        throw new ServiceIdentityAuthorityError("identity_not_enrolled");
      if (current.state !== "pending")
        throw new ServiceIdentityAuthorityError("identity_not_pending");
      if (
        current.kind === "node-agent" &&
        current.enrollmentCredentialFingerprint !== input.certificateFingerprint
      )
        throw new ServiceIdentityAuthorityError(
          "node_enrollment_credential_binding_invalid",
        );
      const credential: ServiceCredentialBinding = Object.freeze({
        certificateFingerprint: input.certificateFingerprint,
        certificateSerial: input.certificateSerial,
        credentialId: input.credentialId,
        generation: 1,
        issuedAt: input.issuedAt,
        notAfter: input.notAfter,
      });
      const permissions = approvedPermissions(current.kind, input.permissions);
      const next = freezeServiceIdentity({
        ...current,
        credentials: Object.freeze([credential]),
        currentCredentialId: credential.credentialId,
        permissions,
        state: "active",
        version: current.version + 1,
      });
      return change({
        current,
        expectedVersion: input.expectedVersion,
        next,
        operationFingerprint,
        operationId: input.operationId,
        outcome: "enrollment_approved",
        actor: input.actor,
      });
    },
    rotateCredential(input) {
      requirePermission(
        input.actor,
        "service_identity.rotate",
        nowMs(),
        options.trustedActorKeys,
      );
      assertCredentialInput(input);
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const current = active(input.identityId);
      if (
        current.credentials.some(
          (credential) =>
            credential.credentialId === input.credentialId ||
            credential.certificateFingerprint ===
              input.certificateFingerprint ||
            credential.certificateSerial === input.certificateSerial,
        )
      )
        throw new ServiceIdentityAuthorityError("credential_identity_reused");
      const nextGeneration =
        Math.max(
          ...current.credentials.map((credential) => credential.generation),
        ) + 1;
      const credential: ServiceCredentialBinding = Object.freeze({
        certificateFingerprint: input.certificateFingerprint,
        certificateSerial: input.certificateSerial,
        credentialId: input.credentialId,
        generation: nextGeneration,
        issuedAt: input.issuedAt,
        notAfter: input.notAfter,
      });
      const next = freezeServiceIdentity({
        ...current,
        credentials: Object.freeze([
          ...current.credentials.map((candidate) =>
            candidate.credentialId === current.currentCredentialId
              ? Object.freeze({ ...candidate, revokedAt: input.issuedAt })
              : candidate,
          ),
          credential,
        ]),
        currentCredentialId: credential.credentialId,
        version: current.version + 1,
      });
      return change({
        current,
        expectedVersion: input.expectedVersion,
        next,
        operationFingerprint,
        operationId: input.operationId,
        outcome: "credential_rotated",
        actor: input.actor,
      });
    },
    revoke(input) {
      requirePermission(
        input.actor,
        "service_identity.revoke",
        nowMs(),
        options.trustedActorKeys,
      );
      assertServiceIdentityRevision(input.revokedAt, "identity_revoked_at");
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const current = store.get(input.identityId);
      if (current === undefined)
        throw new ServiceIdentityAuthorityError("identity_not_enrolled");
      const { currentCredentialId: _currentCredentialId, ...withoutCurrent } =
        current;
      void _currentCredentialId;
      const next = freezeServiceIdentity({
        ...withoutCurrent,
        credentials: Object.freeze(
          current.credentials.map((credential) =>
            credential.revokedAt === undefined
              ? Object.freeze({ ...credential, revokedAt: input.revokedAt })
              : credential,
          ),
        ),
        revocationRevision: current.revocationRevision + 1,
        state: "revoked",
        version: current.version + 1,
      });
      return change({
        current,
        expectedVersion: input.expectedVersion,
        next,
        operationFingerprint,
        operationId: input.operationId,
        outcome: "identity_revoked",
        actor: input.actor,
      });
    },
    quarantine(input) {
      requirePermission(
        input.actor,
        "service_identity.quarantine",
        nowMs(),
        options.trustedActorKeys,
      );
      assertServiceIdentityText(input.reason, "quarantine_reason");
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const current = active(input.identityId);
      const next = freezeServiceIdentity({
        ...current,
        quarantineReason: input.reason,
        revocationRevision: current.revocationRevision + 1,
        state: "quarantined",
        version: current.version + 1,
      });
      return change({
        current,
        expectedVersion: input.expectedVersion,
        next,
        operationFingerprint,
        operationId: input.operationId,
        outcome: "identity_quarantined",
        actor: input.actor,
      });
    },
    advanceNodeBootEpoch(input) {
      requirePermission(
        input.actor,
        "service_identity.boot_epoch",
        nowMs(),
        options.trustedActorKeys,
      );
      const operationFingerprint = fingerprint(input);
      const replay = exactReplay(
        store,
        input.operationId,
        operationFingerprint,
      );
      if (replay !== undefined) return replay;
      const current = active(input.identityId);
      if (current.kind !== "node-agent" || current.nodeId === undefined)
        throw new ServiceIdentityAuthorityError("identity_is_not_node_agent");
      if (input.actor.evidence.boundNodeId !== current.nodeId)
        throw new ServiceIdentityAuthorityError(
          "node_boot_epoch_actor_binding_invalid",
        );
      const generation = current.bootEpochGeneration + 1;
      const next = freezeServiceIdentity({
        ...current,
        bootEpochGeneration: generation,
        currentBootEpoch: `${current.nodeId}:boot:${String(generation)}`,
        version: current.version + 1,
      });
      return change({
        current,
        expectedVersion: input.expectedVersion,
        next,
        operationFingerprint,
        operationId: input.operationId,
        outcome: "boot_epoch_advanced",
        actor: input.actor,
      });
    },
    authenticate,
    authorizeNodeMessage(input) {
      assertServiceIdentityText(input.nonce, "message_nonce");
      assertServiceIdentityRevision(input.sourceSequence, "source_sequence");
      if (input.sourceSequence < 1)
        throw new ServiceIdentityAuthorityError("invalid_source_sequence");
      const principal = authenticate(input);
      const identity = active(input.identityId);
      if (
        identity.kind !== "node-agent" ||
        identity.currentBootEpoch !== input.bootEpoch
      )
        throw new ServiceIdentityAuthorityError("node_boot_epoch_replay");
      const prior = store.getNodeMessageCursor(input.credentialId);
      if (
        prior !== undefined &&
        (prior.nodeId !== input.nodeId ||
          (prior.bootEpoch === input.bootEpoch &&
            (input.sourceSequence <= prior.highestSourceSequence ||
              prior.recentNonces.includes(input.nonce))) ||
          (prior.bootEpoch !== input.bootEpoch && input.sourceSequence !== 1))
      )
        throw new ServiceIdentityAuthorityError("replayed_node_message");
      if (!identity.permissions.includes(input.publication))
        throw new ServiceIdentityAuthorityError(
          "node_publication_not_authorized",
        );
      const recentNonces =
        prior?.bootEpoch === input.bootEpoch
          ? [...prior.recentNonces, input.nonce].slice(-1024)
          : [input.nonce];
      const cursor: NodeMessageReplayCursor = Object.freeze({
        bootEpoch: input.bootEpoch,
        credentialId: input.credentialId,
        highestSourceSequence: input.sourceSequence,
        recentNonces: Object.freeze(recentNonces),
        nodeId: input.nodeId,
        version: (prior?.version ?? 0) + 1,
      });
      store.authorizeNodeMessage(prior?.version ?? 0, cursor);
      return Object.freeze({
        ...principal,
        authorizedPublication: input.publication,
        bootEpoch: input.bootEpoch,
        sourceSequence: input.sourceSequence,
      });
    },
  };
  return Object.freeze(authority);
}
