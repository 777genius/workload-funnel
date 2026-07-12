import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  EXECUTION_TICKET_SCHEMA,
  parseSignedExecutionTicket,
  signExecutionTicket,
  SYNTHETIC_EXECUTION_PROFILE,
  type ExecutionTicketClaims,
  TicketValidationError,
  verifyExecutionTicket,
} from "../index.js";
import { fingerprintMutationFence } from "@workload-funnel/kernel";

function claims(): ExecutionTicketClaims {
  const mutationFence = {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-blue",
    clusterIncarnationVersion: 7,
    desiredEffect: "process_start" as const,
    effectScopeKey: "namespace-1.process-start.attempt-1.generation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 5,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    notAfter: 2_000,
    notBefore: 1_000,
    operationGateRevision: 3,
    ownerFence: 4,
    requiredGate: "process_start",
    schemaVersion: 1 as const,
    startFence: "start-fence-1",
    supersessionKey: "desired-start-1",
  };
  return {
    allocation: {
      allocationId: "allocation-1",
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      ownerFence: 4,
      ownerId: "owner-1",
    },
    attempt: {
      attemptId: "attempt-1",
      executionGeneration: "generation-1",
      startFence: "start-fence-1",
      startRevocationRevision: 0,
    },
    cluster: { incarnationId: "cluster-blue", version: 7 },
    expiresAtMs: 2_000,
    gate: { effect: "process_start", open: true, revision: 3 },
    issuedAtMs: 1_000,
    issuerKeyId: "issuer-1",
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    namespace: {
      namespaceId: "namespace-1",
      writerEpoch: 5,
      writerId: "writer-1",
    },
    node: { bootEpoch: 1, bootId: "boot-1", nodeId: "node-1" },
    nonce: "nonce-1",
    operationId: "start-operation-1",
    partitionPolicy: "terminate_after_grace",
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    sandboxProfileDigest:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: "ticket-1",
  };
}

describe("Phase 4A signed execution ticket", () => {
  it("verifies an exact-node and exact-boot Ed25519 ticket", () => {
    const keys = generateKeyPairSync("ed25519");
    const ticket = signExecutionTicket(claims(), keys.privateKey);

    expect(
      verifyExecutionTicket(ticket, {
        expectedBootId: "boot-1",
        expectedNodeId: "node-1",
        nowMs: 1_500,
        trustedPublicKeys: new Map([["issuer-1", keys.publicKey]]),
      }),
    ).toEqual(claims());
  });

  it("rejects another node, boot, issuer, time window, and signed-field tampering", () => {
    const keys = generateKeyPairSync("ed25519");
    const ticket = signExecutionTicket(claims(), keys.privateKey);
    const policy = {
      expectedBootId: "boot-1",
      expectedNodeId: "node-1",
      nowMs: 1_500,
      trustedPublicKeys: new Map([["issuer-1", keys.publicKey]]),
    };

    expect(() =>
      verifyExecutionTicket(ticket, { ...policy, expectedNodeId: "node-2" }),
    ).toThrow(TicketValidationError);
    expect(() =>
      verifyExecutionTicket(ticket, { ...policy, expectedBootId: "boot-2" }),
    ).toThrow(TicketValidationError);
    expect(() =>
      verifyExecutionTicket(ticket, {
        ...policy,
        trustedPublicKeys: new Map(),
      }),
    ).toThrow(TicketValidationError);
    expect(() =>
      verifyExecutionTicket(ticket, { ...policy, nowMs: 2_000 }),
    ).toThrow(TicketValidationError);

    const tampered = structuredClone(ticket) as unknown as {
      claims: { allocation: { ownerFence: number } };
    };
    tampered.claims.allocation.ownerFence = 99;
    expect(() => verifyExecutionTicket(tampered, policy)).toThrow(
      TicketValidationError,
    );
    const profileTampered = structuredClone(ticket) as unknown as {
      claims: { sandboxProfileDigest: string };
    };
    profileTampered.claims.sandboxProfileDigest = "0".repeat(64);
    expect(() => verifyExecutionTicket(profileTampered, policy)).toThrow(
      TicketValidationError,
    );
  });

  it("uses a closed schema that rejects executable, user, path, and property fields", () => {
    const keys = generateKeyPairSync("ed25519");
    const ticket = signExecutionTicket(claims(), keys.privateKey);
    const attacks: unknown[] = [
      { ...ticket, executable: "/bin/sh" },
      { ...ticket, user: "root" },
      { ...ticket, workingDirectory: "/home/user/project" },
      { ...ticket, properties: { Delegate: true } },
      {
        ...ticket,
        claims: { ...ticket.claims, executable: "/bin/sh" },
      },
    ];

    for (const attack of attacks) {
      expect(() => parseSignedExecutionTicket(attack)).toThrow(
        TicketValidationError,
      );
    }
  });
});
