import {
  EXECUTION_TICKET_SCHEMA,
  type ExecutionTicketClaims,
  type SignedExecutionTicket,
  SYNTHETIC_EXECUTION_PROFILE,
  TicketValidationError,
} from "../domain/execution-ticket.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

interface UntrustedTicketRecord {
  readonly [key: string]: unknown;
  readonly allocation?: unknown;
  readonly allocationId?: unknown;
  readonly attempt?: unknown;
  readonly attemptId?: unknown;
  readonly bootId?: unknown;
  readonly claims?: unknown;
  readonly cluster?: unknown;
  readonly effect?: unknown;
  readonly executionGeneration?: unknown;
  readonly expiresAtMs?: unknown;
  readonly gate?: unknown;
  readonly incarnationId?: unknown;
  readonly issuedAtMs?: unknown;
  readonly issuerKeyId?: unknown;
  readonly namespace?: unknown;
  readonly namespaceId?: unknown;
  readonly node?: unknown;
  readonly nodeId?: unknown;
  readonly open?: unknown;
  readonly ownerFence?: unknown;
  readonly ownerId?: unknown;
  readonly profileId?: unknown;
  readonly revision?: unknown;
  readonly schemaVersion?: unknown;
  readonly signatureBase64Url?: unknown;
  readonly startFence?: unknown;
  readonly startRevocationRevision?: unknown;
  readonly ticketId?: unknown;
  readonly version?: unknown;
  readonly writerEpoch?: unknown;
  readonly writerId?: unknown;
}

function record(value: unknown, location: string): UntrustedTicketRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TicketValidationError(
      "malformed",
      `${location} must be an object`,
    );
  }
  return value as UntrustedTicketRecord;
}

function exactKeys(
  value: UntrustedTicketRecord,
  expected: readonly string[],
  location: string,
): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.join("\u0000") !== canonicalExpected.join("\u0000")) {
    throw new TicketValidationError(
      "malformed",
      `${location} contains missing or unknown fields`,
    );
  }
}

function identifier(value: unknown, location: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new TicketValidationError("invalid_claim", `${location} is invalid`);
  }
  return value;
}

function revision(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TicketValidationError(
      "invalid_claim",
      `${location} must be a non-negative safe integer`,
    );
  }
  return value as number;
}

function timestamp(value: unknown, location: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TicketValidationError(
      "invalid_claim",
      `${location} must be a positive safe integer`,
    );
  }
  return value as number;
}

export function parseExecutionTicketClaims(
  input: unknown,
): ExecutionTicketClaims {
  const claims = record(input, "claims");
  exactKeys(
    claims,
    [
      "allocation",
      "attempt",
      "cluster",
      "expiresAtMs",
      "gate",
      "issuedAtMs",
      "issuerKeyId",
      "namespace",
      "node",
      "profileId",
      "schemaVersion",
      "ticketId",
    ],
    "claims",
  );

  const cluster = record(claims.cluster, "claims.cluster");
  exactKeys(cluster, ["incarnationId", "version"], "claims.cluster");
  const namespace = record(claims.namespace, "claims.namespace");
  exactKeys(
    namespace,
    ["namespaceId", "writerEpoch", "writerId"],
    "claims.namespace",
  );
  const allocation = record(claims.allocation, "claims.allocation");
  exactKeys(
    allocation,
    [
      "allocationId",
      "attemptId",
      "executionGeneration",
      "ownerFence",
      "ownerId",
    ],
    "claims.allocation",
  );
  const attempt = record(claims.attempt, "claims.attempt");
  exactKeys(
    attempt,
    [
      "attemptId",
      "executionGeneration",
      "startFence",
      "startRevocationRevision",
    ],
    "claims.attempt",
  );
  const node = record(claims.node, "claims.node");
  exactKeys(node, ["bootId", "nodeId"], "claims.node");
  const gate = record(claims.gate, "claims.gate");
  exactKeys(gate, ["effect", "open", "revision"], "claims.gate");

  if (claims.schemaVersion !== EXECUTION_TICKET_SCHEMA) {
    throw new TicketValidationError(
      "invalid_claim",
      "unsupported ticket schema",
    );
  }
  if (claims.profileId !== SYNTHETIC_EXECUTION_PROFILE) {
    throw new TicketValidationError(
      "invalid_claim",
      "profile is not allowlisted",
    );
  }
  if (gate.effect !== "process_start" || gate.open !== true) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket gate must authorize process_start",
    );
  }

  const parsed: ExecutionTicketClaims = {
    allocation: {
      allocationId: identifier(allocation.allocationId, "allocationId"),
      attemptId: identifier(allocation.attemptId, "allocation.attemptId"),
      executionGeneration: identifier(
        allocation.executionGeneration,
        "allocation.executionGeneration",
      ),
      ownerFence: revision(allocation.ownerFence, "allocation.ownerFence"),
      ownerId: identifier(allocation.ownerId, "allocation.ownerId"),
    },
    attempt: {
      attemptId: identifier(attempt.attemptId, "attempt.attemptId"),
      executionGeneration: identifier(
        attempt.executionGeneration,
        "attempt.executionGeneration",
      ),
      startFence: identifier(attempt.startFence, "attempt.startFence"),
      startRevocationRevision: revision(
        attempt.startRevocationRevision,
        "attempt.startRevocationRevision",
      ),
    },
    cluster: {
      incarnationId: identifier(cluster.incarnationId, "cluster.incarnationId"),
      version: revision(cluster.version, "cluster.version"),
    },
    expiresAtMs: timestamp(claims.expiresAtMs, "expiresAtMs"),
    gate: {
      effect: "process_start",
      open: true,
      revision: revision(gate.revision, "gate.revision"),
    },
    issuedAtMs: timestamp(claims.issuedAtMs, "issuedAtMs"),
    issuerKeyId: identifier(claims.issuerKeyId, "issuerKeyId"),
    namespace: {
      namespaceId: identifier(namespace.namespaceId, "namespace.namespaceId"),
      writerEpoch: revision(namespace.writerEpoch, "namespace.writerEpoch"),
      writerId: identifier(namespace.writerId, "namespace.writerId"),
    },
    node: {
      bootId: identifier(node.bootId, "node.bootId"),
      nodeId: identifier(node.nodeId, "node.nodeId"),
    },
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: identifier(claims.ticketId, "ticketId"),
  };
  if (
    parsed.allocation.attemptId !== parsed.attempt.attemptId ||
    parsed.allocation.executionGeneration !== parsed.attempt.executionGeneration
  ) {
    throw new TicketValidationError(
      "invalid_claim",
      "Allocation and Attempt identity must be exact",
    );
  }
  if (parsed.expiresAtMs <= parsed.issuedAtMs) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket expiry must follow issuance",
    );
  }
  return parsed;
}

export function parseSignedExecutionTicket(
  input: unknown,
): SignedExecutionTicket {
  const ticket = record(input, "ticket");
  exactKeys(ticket, ["claims", "signatureBase64Url"], "ticket");
  if (
    typeof ticket.signatureBase64Url !== "string" ||
    !/^[A-Za-z0-9_-]{40,256}$/u.test(ticket.signatureBase64Url)
  ) {
    throw new TicketValidationError("malformed", "signature is not base64url");
  }
  return {
    claims: parseExecutionTicketClaims(ticket.claims),
    signatureBase64Url: ticket.signatureBase64Url,
  };
}
