import {
  sign as createSignature,
  type KeyObject,
  verify as verifySignature,
} from "node:crypto";

import {
  canonicalExecutionTicketClaims,
  type ExecutionTicketClaims,
  type SignedExecutionTicket,
  TicketValidationError,
} from "../domain/execution-ticket.js";
import {
  parseExecutionTicketClaims,
  parseSignedExecutionTicket,
} from "./closed-ticket-schema.js";

export interface TicketVerificationPolicy {
  readonly allowExpiredForSafetyOperation?: boolean;
  readonly expectedBootId: string;
  readonly expectedNodeId: string;
  readonly nowMs: number;
  readonly trustedPublicKeys: ReadonlyMap<string, KeyObject>;
}

export function signExecutionTicket(
  untrustedClaims: unknown,
  privateKey: KeyObject,
): SignedExecutionTicket {
  const claims = parseExecutionTicketClaims(untrustedClaims);
  const signature = createSignature(
    null,
    canonicalExecutionTicketClaims(claims),
    privateKey,
  );
  return { claims, signatureBase64Url: signature.toString("base64url") };
}

export function verifyExecutionTicket(
  untrustedTicket: unknown,
  policy: TicketVerificationPolicy,
): ExecutionTicketClaims {
  const ticket = parseSignedExecutionTicket(untrustedTicket);
  const publicKey = policy.trustedPublicKeys.get(ticket.claims.issuerKeyId);
  if (publicKey === undefined) {
    throw new TicketValidationError(
      "unknown_issuer",
      "ticket issuer is not trusted",
    );
  }
  if (
    !verifySignature(
      null,
      canonicalExecutionTicketClaims(ticket.claims),
      publicKey,
      Buffer.from(ticket.signatureBase64Url, "base64url"),
    )
  ) {
    throw new TicketValidationError(
      "invalid_signature",
      "ticket signature is invalid",
    );
  }
  if (
    ticket.claims.node.nodeId !== policy.expectedNodeId ||
    ticket.claims.node.bootId !== policy.expectedBootId
  ) {
    throw new TicketValidationError(
      "node_mismatch",
      "ticket is not bound to this exact node and boot",
    );
  }
  if (policy.nowMs < ticket.claims.issuedAtMs) {
    throw new TicketValidationError("not_yet_valid", "ticket is not yet valid");
  }
  if (
    policy.allowExpiredForSafetyOperation !== true &&
    policy.nowMs >= ticket.claims.expiresAtMs
  ) {
    throw new TicketValidationError("expired", "ticket is expired");
  }
  return ticket.claims;
}
