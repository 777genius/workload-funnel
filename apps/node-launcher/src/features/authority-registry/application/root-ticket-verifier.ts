import type { KeyObject } from "node:crypto";

import {
  type ExecutionTicketClaims,
  TicketValidationError,
  verifyExecutionTicket,
} from "@workload-funnel/node-execution/execution-ticket-validation";

export interface RootTicketVerifierConfig {
  readonly bootId: string;
  readonly nodeId: string;
  readonly nowMs: () => number;
  readonly trustedTicketKeys: ReadonlyMap<string, KeyObject>;
}

export class RootTicketVerificationError extends Error {
  public constructor(public readonly reason: string) {
    super(`execution ticket rejected: ${reason}`);
    this.name = "RootTicketVerificationError";
  }
}

export class RootExecutionTicketVerifier {
  public constructor(private readonly config: RootTicketVerifierConfig) {}

  public verify(
    untrustedTicket: unknown,
    allowExpiredForSafetyOperation: boolean,
  ): ExecutionTicketClaims {
    try {
      return verifyExecutionTicket(untrustedTicket, {
        allowExpiredForSafetyOperation,
        expectedBootId: this.config.bootId,
        expectedNodeId: this.config.nodeId,
        nowMs: this.config.nowMs(),
        trustedPublicKeys: this.config.trustedTicketKeys,
      });
    } catch (error) {
      if (error instanceof TicketValidationError) {
        throw new RootTicketVerificationError(error.code);
      }
      throw new RootTicketVerificationError("invalid_ticket");
    }
  }
}
