import {
  serializeMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

export const EXECUTION_TICKET_SCHEMA = "phase4b.execution-ticket.v1" as const;
export const SYNTHETIC_EXECUTION_PROFILE = "synthetic-process-tree-v1" as const;

export interface ClusterAuthority {
  readonly incarnationId: string;
  readonly version: number;
}

export interface NamespaceAuthority {
  readonly namespaceId: string;
  readonly writerEpoch: number;
  readonly writerId: string;
}

export interface AllocationAuthority {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly ownerFence: number;
  readonly ownerId: string;
}

export interface AttemptStartAuthority {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly startFence: string;
  readonly startRevocationRevision: number;
}

export interface NodeBootAuthority {
  readonly bootId: string;
  readonly bootEpoch: number;
  readonly nodeId: string;
}

export interface ProcessStartGateAuthority {
  readonly effect: "process_start" | "process_stop";
  readonly open: true;
  readonly revision: number;
}

export interface ExecutionTicketClaims {
  readonly allocation: AllocationAuthority;
  readonly attempt: AttemptStartAuthority;
  readonly cluster: ClusterAuthority;
  readonly expiresAtMs: number;
  readonly gate: ProcessStartGateAuthority;
  readonly issuedAtMs: number;
  readonly issuerKeyId: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly namespace: NamespaceAuthority;
  readonly node: NodeBootAuthority;
  readonly nonce: string;
  readonly operationId: string;
  readonly partitionPolicy:
    | "terminate_after_grace"
    | "continue_until_deadline"
    | "executor_fenced";
  readonly profileId: typeof SYNTHETIC_EXECUTION_PROFILE;
  readonly schemaVersion: typeof EXECUTION_TICKET_SCHEMA;
  readonly ticketId: string;
}

export interface SignedExecutionTicket {
  readonly claims: ExecutionTicketClaims;
  readonly signatureBase64Url: string;
}

export type TicketValidationErrorCode =
  | "expired"
  | "invalid_claim"
  | "invalid_signature"
  | "malformed"
  | "node_mismatch"
  | "not_yet_valid"
  | "unknown_issuer";

export class TicketValidationError extends Error {
  public constructor(
    public readonly code: TicketValidationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TicketValidationError";
  }
}

function field(value: string): string {
  return `${String(new TextEncoder().encode(value).byteLength)}:${value}`;
}

export function canonicalExecutionTicketClaims(
  claims: ExecutionTicketClaims,
): Uint8Array {
  const values = [
    claims.schemaVersion,
    claims.ticketId,
    claims.issuerKeyId,
    claims.cluster.incarnationId,
    String(claims.cluster.version),
    claims.namespace.namespaceId,
    claims.namespace.writerId,
    String(claims.namespace.writerEpoch),
    claims.allocation.allocationId,
    claims.allocation.ownerId,
    String(claims.allocation.ownerFence),
    claims.allocation.attemptId,
    claims.allocation.executionGeneration,
    claims.attempt.attemptId,
    claims.attempt.executionGeneration,
    claims.attempt.startFence,
    String(claims.attempt.startRevocationRevision),
    claims.node.nodeId,
    claims.node.bootId,
    String(claims.node.bootEpoch),
    claims.gate.effect,
    String(claims.gate.revision),
    "true",
    claims.profileId,
    claims.nonce,
    claims.operationId,
    claims.partitionPolicy,
    serializeMutationFence(claims.mutationFence),
    claims.mutationFenceFingerprint,
    String(claims.issuedAtMs),
    String(claims.expiresAtMs),
  ];
  return new TextEncoder().encode(values.map(field).join(""));
}
