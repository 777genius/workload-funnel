import type {
  TargetCapabilityDiscovery,
  TargetCanonicalAuthorityGrant,
  TargetOperationIntent,
  TargetOperationReceipt,
} from "@workload-funnel/node-execution/process-lifecycle";
import {
  fingerprintMutationFence,
  type MutationFence,
  sha256Hex,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  RUNTIME_BROKER_CONTRACT_VERSION,
  type RuntimeBrokerCapabilitiesV1,
  type RuntimeOperationReceiptV1,
} from "./contracts/runtime-broker-client.js";
import type { DurableRuntimeOperation } from "./contracts/runtime-operation-store.js";

export type TargetIncapableReason = Extract<
  TargetCapabilityDiscovery,
  { readonly status: "incapable" }
>["reason"];

const mutationKinds = new Set([
  "create",
  "start",
  "resume",
  "input",
  "update",
  "checkpoint",
  "stop",
  "cancel",
  "delete",
]);
const mutationBoundaries = new Set(["runtime", "provider", "session"]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const fenceFingerprintPattern = /^fence-v1-[a-f0-9]{64}$/u;

export function capabilityDecision(
  capabilities: RuntimeBrokerCapabilitiesV1,
  targetId: string,
  intent?: TargetOperationIntent,
): TargetIncapableReason | undefined {
  if (
    capabilities.contractVersion !== RUNTIME_BROKER_CONTRACT_VERSION ||
    capabilities.targetId !== targetId ||
    !/^[a-f0-9]{40,64}$/u.test(capabilities.runtimeBuildSha) ||
    !Array.isArray(capabilities.mutationKinds) ||
    capabilities.mutationKinds.some(
      (kind) => typeof kind !== "string" || !mutationKinds.has(kind),
    ) ||
    !Array.isArray(capabilities.mutationBoundaries) ||
    capabilities.mutationBoundaries.length === 0 ||
    capabilities.mutationBoundaries.some(
      (boundary) =>
        typeof boundary !== "string" || !mutationBoundaries.has(boundary),
    )
  ) {
    return "contract_version_unsupported";
  }
  if (!capabilities.runtimeMutationFencing) {
    return "required_fencing_unsupported";
  }
  if (!capabilities.durableOperationReceipts) {
    return "durable_receipts_unsupported";
  }
  if (!capabilities.cursorSnapshots) {
    return "cursor_snapshot_unsupported";
  }
  if (!capabilities.foregroundOwnedExecution) {
    return "foreground_ownership_unsupported";
  }
  if (
    intent !== undefined &&
    !capabilities.mutationKinds.includes(intent.kind)
  ) {
    return "mutation_kind_unsupported";
  }
  if (
    intent !== undefined &&
    !capabilities.mutationBoundaries.includes(intent.boundary)
  ) {
    return "mutation_boundary_unsupported";
  }
  return undefined;
}

export function runtimeIntentFingerprint(
  intent: TargetOperationIntent,
): string {
  return `runtime-intent-v1-${sha256Hex(
    JSON.stringify([
      intent.kind,
      intent.boundary,
      intent.ticket.schemaVersion,
      intent.ticket.ticketId,
      intent.ticket.operationId,
      intent.ticket.runtimeTargetId,
      intent.ticket.projectId,
      intent.ticket.mutationFenceFingerprint,
      intent.payloadDigest ?? null,
    ]),
  )}`;
}

export function rejectedReceipt(
  intent: TargetOperationIntent,
  rejectionCode: NonNullable<TargetOperationReceipt["rejectionCode"]>,
): TargetOperationReceipt {
  return Object.freeze({
    mutationFenceFingerprint: intent.ticket.mutationFenceFingerprint,
    operationId: intent.ticket.operationId,
    rejectionCode,
    state: "rejected",
  });
}

export function mapRuntimeReceipt(
  receipt: RuntimeOperationReceiptV1,
  operation: DurableRuntimeOperation,
): TargetOperationReceipt {
  if (
    receipt.contractVersion !== RUNTIME_BROKER_CONTRACT_VERSION ||
    receipt.operationId !== operation.operationId ||
    receipt.intentFingerprint !== operation.intentFingerprint ||
    receipt.mutationFenceFingerprint !== operation.mutationFenceFingerprint ||
    !/^[a-f0-9]{40,64}$/u.test(receipt.runtimeBuildSha) ||
    receipt.runtimeOperationId.length === 0 ||
    !["accepted", "running", "completed", "rejected", "unknown"].includes(
      receipt.state,
    )
  ) {
    throw new Error("runtime_operation_receipt_mismatch");
  }
  return Object.freeze({
    mutationFenceFingerprint: receipt.mutationFenceFingerprint,
    operationId: receipt.operationId,
    ...(receipt.rejectionCode === undefined
      ? {}
      : { rejectionCode: "authority_rejected" as const }),
    runtimeBuildSha: receipt.runtimeBuildSha,
    runtimeOperationId: receipt.runtimeOperationId,
    state: receipt.state,
  });
}

export function assertRuntimeIntent(intent: TargetOperationIntent): void {
  const mutationFence: MutationFence = intent.ticket.mutationFence;
  validateMutationFence(mutationFence);
  if (
    intent.ticket.mutationFenceFingerprint !==
      fingerprintMutationFence(mutationFence) ||
    intent.ticket.operationId.length === 0 ||
    intent.ticket.idempotencyKey.length === 0 ||
    !mutationBoundaries.has(intent.boundary)
  ) {
    throw new Error("runtime_operation_intent_invalid");
  }
  const startMutation = [
    "create",
    "start",
    "resume",
    "input",
    "update",
    "checkpoint",
  ].includes(intent.kind);
  if (
    (startMutation && mutationFence.desiredEffect !== "process_start") ||
    (!startMutation && mutationFence.desiredEffect !== "process_stop")
  ) {
    throw new Error("runtime_operation_effect_mismatch");
  }
  if (
    mutationFence.allocationId === undefined ||
    mutationFence.ownerFence === undefined ||
    mutationFence.nodeId === undefined ||
    mutationFence.nodeBootEpoch === undefined ||
    mutationFence.notBefore === undefined ||
    mutationFence.notAfter === undefined
  ) {
    throw new Error("runtime_operation_incomplete_mutation_fence");
  }
}

export function assertCanonicalAuthorityGrant(
  grant: TargetCanonicalAuthorityGrant,
): void {
  const wire = grant as unknown as Readonly<Record<string, unknown>>;
  validateMutationFence(grant.mutationFence);
  for (const value of [
    grant.audience,
    grant.changeId,
    grant.grantId,
    grant.issuerId,
    grant.keyId,
    grant.targetId,
  ]) {
    if (!identifierPattern.test(value) || value !== value.normalize("NFC")) {
      throw new Error("runtime_authority_grant_identity_invalid");
    }
  }
  if (
    wire["schemaVersion"] !== "workload-funnel.runtime-authority-grant.v1" ||
    grant.audience !== `subscription-runtime-broker:${grant.targetId}` ||
    !Number.isSafeInteger(grant.issuedAtMs) ||
    !Number.isSafeInteger(grant.expiresAtMs) ||
    grant.issuedAtMs < 0 ||
    grant.expiresAtMs <= grant.issuedAtMs ||
    grant.signature.length < 32 ||
    grant.issuedAtMs !== grant.mutationFence.notBefore ||
    grant.expiresAtMs !== grant.mutationFence.notAfter ||
    grant.mutationFenceFingerprint !==
      fingerprintMutationFence(grant.mutationFence) ||
    (grant.expectedPriorFingerprint !== undefined &&
      !fenceFingerprintPattern.test(grant.expectedPriorFingerprint))
  ) {
    throw new Error("runtime_authority_grant_invalid");
  }
  const fence = grant.mutationFence;
  if (
    fence.allocationId === undefined ||
    fence.ownerFence === undefined ||
    fence.nodeId === undefined ||
    fence.nodeBootEpoch === undefined ||
    fence.notBefore === undefined ||
    fence.notAfter === undefined ||
    (fence.desiredEffect === "process_start" &&
      (fence.startFence === undefined ||
        fence.issuedStartRevocationRevision === undefined))
  ) {
    throw new Error("runtime_authority_grant_incomplete_fence");
  }
}

export function isExactOperation(
  operation: DurableRuntimeOperation,
  intent: TargetOperationIntent,
  fingerprint: string,
): boolean {
  return (
    operation.idempotencyKey === intent.ticket.idempotencyKey &&
    operation.boundary === intent.boundary &&
    operation.intentFingerprint === fingerprint &&
    operation.mutationFenceFingerprint ===
      intent.ticket.mutationFenceFingerprint &&
    operation.operationId === intent.ticket.operationId &&
    operation.runtimeTargetId === intent.ticket.runtimeTargetId
  );
}
