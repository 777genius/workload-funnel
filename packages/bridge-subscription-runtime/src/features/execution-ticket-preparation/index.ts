import type {
  PreparedTargetTicket,
  TargetExecutionTicket,
  TargetTicketPreparer,
} from "@workload-funnel/node-execution/process-lifecycle";
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;

function assertIdentifier(value: string, field: string): void {
  if (!identifierPattern.test(value) || value !== value.normalize("NFC")) {
    throw new Error(`runtime_ticket_invalid_${field}`);
  }
}

function assertTicket(ticket: TargetExecutionTicket): void {
  const mutationFence: MutationFence = ticket.mutationFence;
  validateMutationFence(mutationFence);
  for (const [field, value] of [
    ["ticket_id", ticket.ticketId],
    ["request_id", ticket.requestId],
    ["operation_id", ticket.operationId],
    ["idempotency_key", ticket.idempotencyKey],
    ["correlation_id", ticket.correlationId],
    ["causation_id", ticket.causationId],
    ["project_id", ticket.projectId],
    ["runtime_target_id", ticket.runtimeTargetId],
  ] as const) {
    assertIdentifier(value, field);
  }
  if (
    !Number.isSafeInteger(ticket.issuedAtMs) ||
    !Number.isSafeInteger(ticket.expiresAtMs) ||
    ticket.issuedAtMs < 0 ||
    ticket.expiresAtMs <= ticket.issuedAtMs ||
    !digestPattern.test(ticket.sandboxProfileDigest)
  ) {
    throw new Error("runtime_ticket_invalid_execution_envelope");
  }
  if (
    !["process_start", "process_stop"].includes(mutationFence.desiredEffect) ||
    mutationFence.requiredGate !== mutationFence.desiredEffect ||
    mutationFence.notBefore !== ticket.issuedAtMs ||
    mutationFence.notAfter !== ticket.expiresAtMs ||
    ticket.mutationFenceFingerprint !== fingerprintMutationFence(mutationFence)
  ) {
    throw new Error("runtime_ticket_mutation_fence_mismatch");
  }
}

export function prepareRuntimeExecutionTicket(
  ticket: TargetExecutionTicket,
): PreparedTargetTicket {
  assertTicket(ticket);
  return Object.freeze({
    ...ticket,
    executionMode: "foreground",
    schemaVersion: "subscription-runtime.execution-ticket.v1",
  });
}

export function createProvider(): TargetTicketPreparer {
  return Object.freeze({ prepare: prepareRuntimeExecutionTicket });
}
