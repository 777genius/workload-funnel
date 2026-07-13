import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  GatewayContractError,
  SCHEDULER_GATEWAY_PROTOCOL,
  validateFenceForSchedulerScope,
  validateSchedulerMutationScope,
  verifySchedulerFenceInstallAcknowledgement,
  verifySchedulerFenceInstallSignature,
  type SchedulerScopeCloseAcknowledgement,
  type SchedulerScopeCloseRequest,
  type SchedulerScopeReopenRequest,
  type SignedSchedulerFenceInstall,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const installReasons = new Set([
  "allocation_takeover",
  "attempt_revocation",
  "cluster_rotation",
  "desired_effect_supersession",
  "gate_change",
  "namespace_transfer",
]);

function exactKeys(
  value: unknown,
  keys: readonly string[],
  field: string,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new GatewayContractError("invalid_gateway_request", field);
}

function identifier(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !identifierPattern.test(value) ||
    value !== value.normalize("NFC")
  )
    throw new GatewayContractError("invalid_gateway_request", field);
}

function signature(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    throw new GatewayContractError("invalid_gateway_request", "signature");
}

function snapshot<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (typeof item !== "object" || item === null || Object.isFrozen(item))
      return;
    for (const nested of Object.values(item)) freeze(nested);
    Object.freeze(item);
  };
  freeze(cloned);
  return cloned;
}

export function snapshotCloseRequest(
  request: SchedulerScopeCloseRequest,
): SchedulerScopeCloseRequest {
  return snapshot(request);
}

export function snapshotInstallRequest(
  request: SignedSchedulerFenceInstall,
): SignedSchedulerFenceInstall {
  return snapshot(request);
}

export function snapshotReopenRequest(
  request: SchedulerScopeReopenRequest,
): SchedulerScopeReopenRequest {
  return snapshot(request);
}

export function validateCloseRequest(
  request: SchedulerScopeCloseRequest,
  authorityId: string,
): void {
  exactKeys(request, ["authorityId", "closeOperationId", "scope"], "close");
  if (request.authorityId !== authorityId)
    throw new GatewayContractError("invalid_gateway_request", "authority");
  identifier(request.closeOperationId, "close_operation_id");
  validateSchedulerMutationScope(request.scope);
}

export function validateInstallRequest(
  request: SignedSchedulerFenceInstall,
  input: Readonly<{
    authorityId: string;
    nowMs: number;
    trustedInstallKeys: ReadonlyMap<string, Uint8Array>;
  }>,
): void {
  exactKeys(request, ["claims", "signatureBase64Url"], "install_envelope");
  exactKeys(
    request.claims,
    [
      "authorityId",
      "expectedPriorFingerprint",
      "installOperationId",
      "issuedAtMs",
      "issuerKeyId",
      "mutationFence",
      "mutationFenceFingerprint",
      "notAfterMs",
      "protocolVersion",
      "reason",
      "scope",
    ],
    "install_claims",
  );
  const claims = request.claims;
  const fence: MutationFence = claims.mutationFence;
  identifier(claims.installOperationId, "install_operation_id");
  identifier(claims.issuerKeyId, "issuer_key_id");
  signature(request.signatureBase64Url);
  const key = input.trustedInstallKeys.get(claims.issuerKeyId);
  if (key === undefined || !verifySchedulerFenceInstallSignature(request, key))
    throw new GatewayContractError("install_signature_invalid");
  const protocolVersion: unknown = claims.protocolVersion;
  if (
    protocolVersion !== SCHEDULER_GATEWAY_PROTOCOL ||
    claims.authorityId !== input.authorityId ||
    !Number.isSafeInteger(claims.issuedAtMs) ||
    !Number.isSafeInteger(claims.notAfterMs) ||
    claims.issuedAtMs > input.nowMs ||
    claims.notAfterMs <= input.nowMs ||
    !installReasons.has(claims.reason) ||
    (claims.expectedPriorFingerprint !== null &&
      !/^fence-v1-[a-f0-9]{64}$/u.test(claims.expectedPriorFingerprint)) ||
    fingerprintMutationFence(fence) !== claims.mutationFenceFingerprint
  )
    throw new GatewayContractError("invalid_gateway_request", "install");
  validateFenceForSchedulerScope(fence, claims.scope);
}

export function validateInstallAcknowledgement(
  acknowledgement: SignedSchedulerFenceInstallAcknowledgement,
  authorityId: string,
  acknowledgementKey: Uint8Array,
): void {
  exactKeys(
    acknowledgement,
    ["claims", "signatureBase64Url"],
    "install_ack_envelope",
  );
  exactKeys(
    acknowledgement.claims,
    [
      "authorityId",
      "comparisonFields",
      "comparisonResult",
      "drainDisposition",
      "installOperationId",
      "installedFingerprint",
      "invalidatedQueueCount",
      "protocolVersion",
      "registrySequence",
      "result",
      "scope",
    ],
    "install_ack_claims",
  );
  signature(acknowledgement.signatureBase64Url);
  const claims = acknowledgement.claims;
  if (
    claims.authorityId !== authorityId ||
    !/^fence-v1-[a-f0-9]{64}$/u.test(claims.installedFingerprint) ||
    !Number.isSafeInteger(claims.registrySequence) ||
    claims.registrySequence < 1 ||
    !verifySchedulerFenceInstallAcknowledgement(
      acknowledgement,
      acknowledgementKey,
    )
  )
    throw new GatewayContractError("invalid_gateway_request", "install_ack");
  validateSchedulerMutationScope(claims.scope);
}

export function validateReopenRequest(
  request: SchedulerScopeReopenRequest,
  authorityId: string,
  acknowledgementKey: Uint8Array,
): void {
  exactKeys(request, ["acknowledgement", "reopenOperationId"], "reopen");
  identifier(request.reopenOperationId, "reopen_operation_id");
  validateInstallAcknowledgement(
    request.acknowledgement,
    authorityId,
    acknowledgementKey,
  );
}

export function validateRecoveredCloseAcknowledgement(
  acknowledgement: SchedulerScopeCloseAcknowledgement,
  sequence: number,
): void {
  exactKeys(
    acknowledgement,
    [
      "closeOperationId",
      "disposition",
      "invalidatedQueueCount",
      "registrySequence",
      "scope",
    ],
    "close_ack",
  );
  identifier(acknowledgement.closeOperationId, "close_operation_id");
  validateSchedulerMutationScope(acknowledgement.scope);
  const disposition: unknown = acknowledgement.disposition;
  if (
    acknowledgement.registrySequence !== sequence ||
    (disposition !== "drained" && disposition !== "unresolved")
  )
    throw new GatewayContractError("invalid_gateway_request", "close_ack");
}
