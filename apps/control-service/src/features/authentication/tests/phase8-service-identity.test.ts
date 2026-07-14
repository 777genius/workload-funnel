import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createDurableServiceIdentityAuthority,
  serviceEnrollmentProofDigest,
  signServiceIdentityActor,
  type ServiceIdentityActor,
  type ServiceIdentityAuthorizationEvidence,
} from "../index.js";
import { openSqliteServiceIdentityAuthorityStore } from "../adapters/sqlite-service-identity-authority-store.js";
import {
  createInMemoryServiceIdentityStoreTestFake,
  createInMemoryServiceIdentityStoreTestState,
} from "../adapters/synthetic-durable-service-identity-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-phase8-identity-"));
  roots.push(root);
  return join(root, "identity.sqlite");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const actorKeys = generateKeyPairSync("ed25519");
const trustedActorKeys = new Map([
  ["synthetic-identity-actor-key", actorKeys.publicKey],
]);

function actor(
  overrides: Partial<
    Omit<ServiceIdentityAuthorizationEvidence, "signatureBase64Url">
  > = {},
  unbound = false,
): ServiceIdentityActor {
  return signServiceIdentityActor(
    {
      evidence: Object.freeze({
        audience: "workload-funnel-service-identity" as const,
        authenticatedAt: 90,
        authenticationMethod: "mtls" as const,
        authorizationDecisionId: "authorization-phase8-1",
        ...(unbound
          ? {}
          : {
              boundCredentialFingerprint: "certificate-fingerprint-node-1",
              boundNodeId: "node-1",
            }),
        evidenceDigest: digest("authenticated-authorization-evidence"),
        expiresAt: 200,
        nonce: "authorization-nonce-phase8-1",
        signerKeyId: "synthetic-identity-actor-key",
        ...overrides,
      }),
      permissions: new Set([
        "service_identity.enroll" as const,
        "service_identity.approve" as const,
        "service_identity.rotate" as const,
        "service_identity.revoke" as const,
        "service_identity.quarantine" as const,
        "service_identity.boot_epoch" as const,
      ]),
      principalId: "operator:phase8-identity",
    },
    actorKeys.privateKey,
  );
}

function enrollNode(
  authority: ReturnType<typeof createDurableServiceIdentityAuthority>,
  enrollmentActor = actor(),
) {
  const proof = serviceEnrollmentProofDigest({
    actor: enrollmentActor,
    identityId: "identity-node-1",
    nodeId: "node-1",
  });
  authority.requestEnrollment({
    actor: enrollmentActor,
    audience: "workload-funnel-control",
    enrollmentProofDigest: proof,
    identityId: "identity-node-1",
    kind: "node-agent",
    nodeId: "node-1",
    operationId: "enroll-node-1",
  });
  return authority.approveEnrollment({
    actor: enrollmentActor,
    certificateFingerprint: "certificate-fingerprint-node-1",
    certificateSerial: "certificate-serial-node-1",
    credentialId: "credential-node-1",
    expectedVersion: 1,
    identityId: "identity-node-1",
    issuedAt: 90,
    notAfter: 1000,
    operationId: "approve-node-1",
    permissions: ["node.capacity.publish", "node.result.publish"],
  });
}

describe("Phase 8 authenticated durable service and node identity", () => {
  it("refuses an explicitly named volatile test fake in production authority composition", () => {
    expect(() =>
      createDurableServiceIdentityAuthority(
        createInMemoryServiceIdentityStoreTestFake(
          createInMemoryServiceIdentityStoreTestState(),
        ),
        { trustedActorKeys },
      ),
    ).toThrow("identity_authority_incapable");
  });

  it("survives a real SQLite close/reopen with actor, node, credential, boot, and replay bindings", () => {
    const path = databasePath();
    let opened = openSqliteServiceIdentityAuthorityStore(path);
    let authority = createDurableServiceIdentityAuthority(opened.store, {
      nowMs: () => 100,
      trustedActorKeys,
    });
    enrollNode(authority);
    expect(opened.store.get("identity-node-1")).toMatchObject({
      enrollmentActorPrincipalId: "operator:phase8-identity",
      enrollmentAuthorizationEvidenceDigest: digest(
        "authenticated-authorization-evidence",
      ),
      enrollmentCredentialFingerprint: "certificate-fingerprint-node-1",
    });
    const boot = authority.advanceNodeBootEpoch({
      actor: actor(),
      expectedVersion: 2,
      identityId: "identity-node-1",
      operationId: "boot-node-1",
    });
    expect(boot.currentBootEpoch).toBe("node-1:boot:1");
    authority.authorizeNodeMessage({
      audience: "workload-funnel-control",
      bootEpoch: "node-1:boot:1",
      certificateFingerprint: "certificate-fingerprint-node-1",
      certificateSerial: "certificate-serial-node-1",
      credentialId: "credential-node-1",
      identityId: "identity-node-1",
      nodeId: "node-1",
      nonce: "node-message-nonce-1",
      now: 110,
      publication: "node.capacity.publish",
      sourceSequence: 1,
    });
    expect(opened.store.getOperation("enroll-node-1")).toMatchObject({
      actorPrincipalId: "operator:phase8-identity",
      authorizationEvidenceDigest: digest(
        "authenticated-authorization-evidence",
      ),
    });
    opened.close();

    opened = openSqliteServiceIdentityAuthorityStore(path);
    authority = createDurableServiceIdentityAuthority(opened.store, {
      nowMs: () => 120,
      trustedActorKeys,
    });
    expect(
      authority.authenticate({
        audience: "workload-funnel-control",
        certificateFingerprint: "certificate-fingerprint-node-1",
        certificateSerial: "certificate-serial-node-1",
        credentialId: "credential-node-1",
        identityId: "identity-node-1",
        nodeId: "node-1",
        now: 120,
      }).nodeId,
    ).toBe("node-1");
    expect(() =>
      authority.authorizeNodeMessage({
        audience: "workload-funnel-control",
        bootEpoch: "node-1:boot:1",
        certificateFingerprint: "certificate-fingerprint-node-1",
        certificateSerial: "certificate-serial-node-1",
        credentialId: "credential-node-1",
        identityId: "identity-node-1",
        nodeId: "node-1",
        nonce: "node-message-nonce-after-restart",
        now: 120,
        publication: "node.capacity.publish",
        sourceSequence: 1,
      }),
    ).toThrow("replayed_node_message");
    opened.close();
  });

  it("rejects unauthenticated preclaim, duplicate node identity, credential reuse, and old boot epochs", () => {
    const opened = openSqliteServiceIdentityAuthorityStore(databasePath());
    const authority = createDurableServiceIdentityAuthority(opened.store, {
      nowMs: () => 100,
      trustedActorKeys,
    });
    const expired = actor({ expiresAt: 100 });
    expect(() =>
      authority.requestEnrollment({
        actor: expired,
        audience: "workload-funnel-control",
        enrollmentProofDigest: digest("asserted-proof"),
        identityId: "preclaim-node-1",
        kind: "node-agent",
        nodeId: "node-1",
        operationId: "preclaim-node-1",
      }),
    ).toThrow("service_identity_forbidden");
    expect(opened.store.get("preclaim-node-1")).toBeUndefined();

    enrollNode(authority);
    const duplicateActor = actor({
      authorizationDecisionId: "authorization-phase8-duplicate",
      evidenceDigest: digest("duplicate-node-authorization"),
      nonce: "authorization-nonce-phase8-duplicate",
    });
    expect(() =>
      authority.requestEnrollment({
        actor: duplicateActor,
        audience: "workload-funnel-control",
        enrollmentProofDigest: serviceEnrollmentProofDigest({
          actor: duplicateActor,
          identityId: "identity-node-duplicate",
          nodeId: "node-1",
        }),
        identityId: "identity-node-duplicate",
        kind: "node-agent",
        nodeId: "node-1",
        operationId: "enroll-node-duplicate",
      }),
    ).toThrow("node_identity_already_bound");

    const serviceActor = actor(
      {
        authorizationDecisionId: "authorization-phase8-service",
        evidenceDigest: digest("service-authorization"),
        nonce: "authorization-nonce-phase8-service",
      },
      true,
    );
    authority.requestEnrollment({
      actor: serviceActor,
      audience: "workload-funnel-control",
      enrollmentProofDigest: digest("control-service-enrollment"),
      identityId: "identity-control-1",
      kind: "control-service",
      operationId: "enroll-control-1",
    });
    expect(() =>
      authority.approveEnrollment({
        actor: serviceActor,
        certificateFingerprint: "certificate-fingerprint-node-1",
        certificateSerial: "different-serial",
        credentialId: "different-credential",
        expectedVersion: 1,
        identityId: "identity-control-1",
        issuedAt: 90,
        notAfter: 1000,
        operationId: "approve-control-1",
        permissions: [],
      }),
    ).toThrow("credential_identity_reused");

    authority.advanceNodeBootEpoch({
      actor: actor(),
      expectedVersion: 2,
      identityId: "identity-node-1",
      operationId: "boot-node-1",
    });
    authority.advanceNodeBootEpoch({
      actor: actor(),
      expectedVersion: 3,
      identityId: "identity-node-1",
      operationId: "boot-node-2",
    });
    expect(() =>
      authority.authorizeNodeMessage({
        audience: "workload-funnel-control",
        bootEpoch: "node-1:boot:1",
        certificateFingerprint: "certificate-fingerprint-node-1",
        certificateSerial: "certificate-serial-node-1",
        credentialId: "credential-node-1",
        identityId: "identity-node-1",
        nodeId: "node-1",
        nonce: "old-boot-message-nonce",
        now: 110,
        publication: "node.capacity.publish",
        sourceSequence: 1,
      }),
    ).toThrow("node_boot_epoch_replay");
    opened.close();
  });

  it("verifies the signed actor decision and exact enrollment credential before approval", () => {
    const opened = openSqliteServiceIdentityAuthorityStore(databasePath());
    const authority = createDurableServiceIdentityAuthority(opened.store, {
      nowMs: () => 100,
      trustedActorKeys,
    });
    const authenticatedActor = actor({
      authorizationDecisionId: "authorization-credential-binding",
      boundCredentialFingerprint: "certificate-bound-by-enrollment",
      boundNodeId: "node-binding",
      evidenceDigest: digest("credential-binding-evidence"),
      nonce: "authorization-nonce-credential-binding",
    });
    const tamperedActor = Object.freeze({
      ...authenticatedActor,
      evidence: Object.freeze({
        ...authenticatedActor.evidence,
        authorizationDecisionId: "tampered-authorization-decision",
      }),
    });
    expect(() =>
      authority.requestEnrollment({
        actor: tamperedActor,
        audience: "workload-funnel-control",
        enrollmentProofDigest: serviceEnrollmentProofDigest({
          actor: tamperedActor,
          identityId: "identity-node-binding",
          nodeId: "node-binding",
        }),
        identityId: "identity-node-binding",
        kind: "node-agent",
        nodeId: "node-binding",
        operationId: "tampered-enrollment",
      }),
    ).toThrow("service_identity_forbidden");
    authority.requestEnrollment({
      actor: authenticatedActor,
      audience: "workload-funnel-control",
      enrollmentProofDigest: serviceEnrollmentProofDigest({
        actor: authenticatedActor,
        identityId: "identity-node-binding",
        nodeId: "node-binding",
      }),
      identityId: "identity-node-binding",
      kind: "node-agent",
      nodeId: "node-binding",
      operationId: "bound-enrollment",
    });
    const approval = {
      actor: authenticatedActor,
      certificateSerial: "certificate-serial-binding",
      credentialId: "credential-binding",
      expectedVersion: 1,
      identityId: "identity-node-binding",
      issuedAt: 90,
      notAfter: 1000,
      operationId: "approve-bound-enrollment",
      permissions: ["node.capacity.publish"] as const,
    };
    expect(() =>
      authority.approveEnrollment({
        ...approval,
        certificateFingerprint: "substituted-certificate",
      }),
    ).toThrow("node_enrollment_credential_binding_invalid");
    expect(
      authority.approveEnrollment({
        ...approval,
        certificateFingerprint: "certificate-bound-by-enrollment",
      }).currentCredentialId,
    ).toBe("credential-binding");
    opened.close();
  });
});
