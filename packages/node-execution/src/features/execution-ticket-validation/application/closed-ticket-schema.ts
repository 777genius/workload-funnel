import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  EXECUTION_TICKET_SCHEMA,
  type ExecutionTicketClaims,
  type SignedExecutionTicket,
  SYNTHETIC_EXECUTION_PROFILE,
  TicketValidationError,
} from "../domain/execution-ticket.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const namespaceIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

interface UntrustedTicketRecord {
  readonly [key: string]: unknown;
  readonly allocation?: unknown;
  readonly allocationId?: unknown;
  readonly attempt?: unknown;
  readonly attemptId?: unknown;
  readonly bootId?: unknown;
  readonly bootEpoch?: unknown;
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
  readonly mutationFence?: unknown;
  readonly mutationFenceFingerprint?: unknown;
  readonly node?: unknown;
  readonly nodeId?: unknown;
  readonly nonce?: unknown;
  readonly open?: unknown;
  readonly ownerFence?: unknown;
  readonly ownerId?: unknown;
  readonly operationId?: unknown;
  readonly partitionPolicy?: unknown;
  readonly profileId?: unknown;
  readonly revision?: unknown;
  readonly schemaVersion?: unknown;
  readonly sandboxProfileDigest?: unknown;
  readonly signatureBase64Url?: unknown;
  readonly startFence?: unknown;
  readonly startRevocationRevision?: unknown;
  readonly ticketId?: unknown;
  readonly version?: unknown;
  readonly writerEpoch?: unknown;
  readonly writerId?: unknown;
  readonly clusterIncarnation?: unknown;
  readonly clusterIncarnationVersion?: unknown;
  readonly namespaceWriterEpoch?: unknown;
  readonly operationGateRevision?: unknown;
  readonly requiredGate?: unknown;
  readonly desiredEffect?: unknown;
  readonly expectedDesiredVersion?: unknown;
  readonly supersessionKey?: unknown;
  readonly effectScopeKey?: unknown;
  readonly issuedStartRevocationRevision?: unknown;
  readonly nodeBootEpoch?: unknown;
  readonly notBefore?: unknown;
  readonly notAfter?: unknown;
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

function namespaceIdentifier(value: unknown, location: string): string {
  if (
    typeof value !== "string" ||
    !namespaceIdentifierPattern.test(value) ||
    value !== value.normalize("NFC")
  ) {
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

function parseMutationFence(value: unknown): MutationFence {
  const fence = record(value, "claims.mutationFence");
  const desiredEffect = fence.desiredEffect;
  if (desiredEffect !== "process_start" && desiredEffect !== "process_stop") {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket fence must be a process mutation fence",
    );
  }
  exactKeys(
    fence,
    [
      "allocationId",
      "attemptId",
      "clusterIncarnation",
      "clusterIncarnationVersion",
      "desiredEffect",
      "effectScopeKey",
      "executionGeneration",
      "expectedDesiredVersion",
      "namespaceId",
      "namespaceWriterEpoch",
      "nodeBootEpoch",
      "nodeId",
      "notAfter",
      "notBefore",
      "operationGateRevision",
      "ownerFence",
      "requiredGate",
      "schemaVersion",
      "supersessionKey",
      ...(desiredEffect === "process_start"
        ? ["issuedStartRevocationRevision", "startFence"]
        : []),
    ],
    "claims.mutationFence",
  );
  if (fence.schemaVersion !== 1) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket fence schema is unsupported",
    );
  }
  const parsed: MutationFence = {
    allocationId: identifier(fence.allocationId, "fence.allocationId"),
    attemptId: identifier(fence.attemptId, "fence.attemptId"),
    clusterIncarnation: identifier(
      fence.clusterIncarnation,
      "fence.clusterIncarnation",
    ),
    clusterIncarnationVersion: revision(
      fence.clusterIncarnationVersion,
      "fence.clusterIncarnationVersion",
    ),
    desiredEffect,
    effectScopeKey: identifier(fence.effectScopeKey, "fence.effectScopeKey"),
    executionGeneration: identifier(
      fence.executionGeneration,
      "fence.executionGeneration",
    ),
    expectedDesiredVersion: revision(
      fence.expectedDesiredVersion,
      "fence.expectedDesiredVersion",
    ),
    namespaceId: namespaceIdentifier(fence.namespaceId, "fence.namespaceId"),
    namespaceWriterEpoch: revision(
      fence.namespaceWriterEpoch,
      "fence.namespaceWriterEpoch",
    ),
    nodeBootEpoch: revision(fence.nodeBootEpoch, "fence.nodeBootEpoch"),
    nodeId: identifier(fence.nodeId, "fence.nodeId"),
    notAfter: revision(fence.notAfter, "fence.notAfter"),
    notBefore: revision(fence.notBefore, "fence.notBefore"),
    operationGateRevision: revision(
      fence.operationGateRevision,
      "fence.operationGateRevision",
    ),
    ownerFence: revision(fence.ownerFence, "fence.ownerFence"),
    requiredGate: identifier(fence.requiredGate, "fence.requiredGate"),
    schemaVersion: 1,
    supersessionKey: identifier(fence.supersessionKey, "fence.supersessionKey"),
    ...(desiredEffect === "process_start"
      ? {
          issuedStartRevocationRevision: revision(
            fence.issuedStartRevocationRevision,
            "fence.issuedStartRevocationRevision",
          ),
          startFence: identifier(fence.startFence, "fence.startFence"),
        }
      : {}),
  };
  try {
    validateMutationFence(parsed);
  } catch {
    throw new TicketValidationError(
      "invalid_claim",
      "mutation fence is invalid",
    );
  }
  return parsed;
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
      "mutationFence",
      "mutationFenceFingerprint",
      "namespace",
      "node",
      "nonce",
      "operationId",
      "partitionPolicy",
      "profileId",
      "sandboxProfileDigest",
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
  exactKeys(node, ["bootEpoch", "bootId", "nodeId"], "claims.node");
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
  if (
    (gate.effect !== "process_start" && gate.effect !== "process_stop") ||
    gate.open !== true
  ) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket gate must authorize a process mutation",
    );
  }

  const mutationFence = parseMutationFence(claims.mutationFence);
  if (gate.effect !== mutationFence.desiredEffect) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket gate and desired effect must match",
    );
  }
  if (
    claims.partitionPolicy !== "terminate_after_grace" &&
    claims.partitionPolicy !== "continue_until_deadline" &&
    claims.partitionPolicy !== "executor_fenced"
  ) {
    throw new TicketValidationError(
      "invalid_claim",
      "partition policy is invalid",
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
      effect: gate.effect,
      open: true,
      revision: revision(gate.revision, "gate.revision"),
    },
    issuedAtMs: timestamp(claims.issuedAtMs, "issuedAtMs"),
    issuerKeyId: identifier(claims.issuerKeyId, "issuerKeyId"),
    mutationFence,
    mutationFenceFingerprint: identifier(
      claims.mutationFenceFingerprint,
      "mutationFenceFingerprint",
    ),
    namespace: {
      namespaceId: namespaceIdentifier(
        namespace.namespaceId,
        "namespace.namespaceId",
      ),
      writerEpoch: revision(namespace.writerEpoch, "namespace.writerEpoch"),
      writerId: identifier(namespace.writerId, "namespace.writerId"),
    },
    node: {
      bootId: identifier(node.bootId, "node.bootId"),
      bootEpoch: revision(node.bootEpoch, "node.bootEpoch"),
      nodeId: identifier(node.nodeId, "node.nodeId"),
    },
    nonce: identifier(claims.nonce, "nonce"),
    operationId: identifier(claims.operationId, "operationId"),
    partitionPolicy: claims.partitionPolicy,
    profileId: SYNTHETIC_EXECUTION_PROFILE,
    sandboxProfileDigest: identifier(
      claims.sandboxProfileDigest,
      "sandboxProfileDigest",
    ),
    schemaVersion: EXECUTION_TICKET_SCHEMA,
    ticketId: identifier(claims.ticketId, "ticketId"),
  };
  if (!/^[a-f0-9]{64}$/u.test(parsed.sandboxProfileDigest)) {
    throw new TicketValidationError(
      "invalid_claim",
      "sandbox profile digest is invalid",
    );
  }
  if (
    parsed.allocation.attemptId !== parsed.attempt.attemptId ||
    parsed.allocation.executionGeneration !== parsed.attempt.executionGeneration
  ) {
    throw new TicketValidationError(
      "invalid_claim",
      "Allocation and Attempt identity must be exact",
    );
  }
  if (
    parsed.mutationFenceFingerprint !==
      fingerprintMutationFence(parsed.mutationFence) ||
    parsed.mutationFence.clusterIncarnation !== parsed.cluster.incarnationId ||
    parsed.mutationFence.clusterIncarnationVersion !== parsed.cluster.version ||
    parsed.mutationFence.namespaceId !== parsed.namespace.namespaceId ||
    parsed.mutationFence.namespaceWriterEpoch !==
      parsed.namespace.writerEpoch ||
    parsed.mutationFence.operationGateRevision !== parsed.gate.revision ||
    parsed.mutationFence.requiredGate !== parsed.gate.effect ||
    parsed.mutationFence.allocationId !== parsed.allocation.allocationId ||
    parsed.mutationFence.ownerFence !== parsed.allocation.ownerFence ||
    parsed.mutationFence.attemptId !== parsed.attempt.attemptId ||
    parsed.mutationFence.executionGeneration !==
      parsed.attempt.executionGeneration ||
    (parsed.mutationFence.desiredEffect === "process_start" &&
      (parsed.mutationFence.startFence !== parsed.attempt.startFence ||
        parsed.mutationFence.issuedStartRevocationRevision !==
          parsed.attempt.startRevocationRevision)) ||
    parsed.mutationFence.nodeId !== parsed.node.nodeId ||
    parsed.mutationFence.nodeBootEpoch !== parsed.node.bootEpoch ||
    parsed.mutationFence.notBefore !== parsed.issuedAtMs ||
    parsed.mutationFence.notAfter !== parsed.expiresAtMs
  ) {
    throw new TicketValidationError(
      "invalid_claim",
      "ticket duplicates do not equal the complete mutation fence",
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
