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

function claims(): ExecutionTicketClaims {
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
    namespace: {
      namespaceId: "namespace-1",
      writerEpoch: 5,
      writerId: "writer-1",
    },
    node: { bootId: "boot-1", nodeId: "node-1" },
    profileId: SYNTHETIC_EXECUTION_PROFILE,
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
