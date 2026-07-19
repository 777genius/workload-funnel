import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  GatewayContractError,
  SCHEDULER_GATEWAY_PROTOCOL,
  authorizedMutationBrand,
  type AuthorizedHyperQueueMutation,
  type HyperQueueMutation,
  type MutateHyperQueueRequest,
  type SchedulerMutationScope,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "./gateway-contract.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function assertIdentifier(value: unknown, field: string): void {
  if (
    typeof value !== "string" ||
    !identifierPattern.test(value) ||
    value !== value.normalize("NFC")
  )
    throw new GatewayContractError("invalid_gateway_request", field);
}

function assertPositive(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new GatewayContractError("invalid_gateway_request", field);
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): void {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...expected].sort().join()
  )
    throw new GatewayContractError("invalid_gateway_request", field);
}

function sameDispatchIdentity(
  left: SchedulerMutationScope,
  right: SchedulerMutationScope,
): boolean {
  return (
    left.schedulerInstanceId === right.schedulerInstanceId &&
    left.namespaceId === right.namespaceId &&
    left.attemptId === right.attemptId &&
    left.executionGeneration === right.executionGeneration &&
    left.allocationId === right.allocationId &&
    left.dispatchId === right.dispatchId
  );
}

const comparisonFieldKeys = [
  "allocationId",
  "attemptId",
  "clusterIncarnation",
  "clusterIncarnationVersion",
  "desiredEffect",
  "effectScopeKey",
  "executionGeneration",
  "expectedDesiredVersion",
  "issuedStartRevocationRevision",
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
  "startFence",
  "supersessionKey",
] as const;

function validateAcknowledgementStructure(
  acknowledgement: SignedSchedulerFenceInstallAcknowledgement,
  field: string,
): void {
  exactKeys(
    acknowledgement,
    ["claims", "signatureBase64Url"],
    `${field}_envelope`,
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
    `${field}_claims`,
  );
  exactKeys(
    acknowledgement.claims.comparisonFields,
    comparisonFieldKeys,
    `${field}_comparison_fields`,
  );
  validateSchedulerMutationScope(acknowledgement.claims.scope);
  const claims = acknowledgement.claims;
  const protocolVersion: unknown = claims.protocolVersion;
  if (
    protocolVersion !== SCHEDULER_GATEWAY_PROTOCOL ||
    !Number.isSafeInteger(claims.registrySequence) ||
    claims.registrySequence < 1 ||
    !Number.isSafeInteger(claims.invalidatedQueueCount) ||
    claims.invalidatedQueueCount < 0 ||
    !/^[A-Za-z0-9_-]{43}$/u.test(acknowledgement.signatureBase64Url) ||
    !/^fence-v1-[a-f0-9]{64}$/u.test(claims.installedFingerprint)
  )
    throw new GatewayContractError("invalid_gateway_request", field);
}

function validateClosedMutationFence(fence: MutationFence): void {
  const candidate: unknown = fence;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    Array.isArray(candidate)
  )
    throw new GatewayContractError("invalid_gateway_request", "mutation_fence");
  const required = [
    "attemptId",
    "clusterIncarnation",
    "clusterIncarnationVersion",
    "desiredEffect",
    "effectScopeKey",
    "executionGeneration",
    "expectedDesiredVersion",
    "namespaceId",
    "namespaceWriterEpoch",
    "operationGateRevision",
    "requiredGate",
    "schemaVersion",
    "supersessionKey",
  ];
  const optional = [
    "allocationId",
    "issuedStartRevocationRevision",
    "nodeBootEpoch",
    "nodeId",
    "notAfter",
    "notBefore",
    "ownerFence",
    "startFence",
  ].filter((key) => Object.hasOwn(fence, key));
  exactKeys(fence, [...required, ...optional], "mutation_fence");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function schedulerMutationScopeKey(
  scope: SchedulerMutationScope,
): string {
  validateSchedulerMutationScope(scope);
  return [
    scope.schedulerInstanceId,
    scope.namespaceId,
    scope.effectKind,
    scope.attemptId,
    scope.executionGeneration,
    scope.allocationId,
    scope.dispatchId,
  ].join("\u0000");
}

export function validateSchedulerMutationScope(
  scope: SchedulerMutationScope,
): void {
  exactKeys(
    scope,
    [
      "allocationId",
      "attemptId",
      "dispatchId",
      "effectKind",
      "executionGeneration",
      "namespaceId",
      "schedulerInstanceId",
    ],
    "scope",
  );
  for (const [field, value] of Object.entries(scope)) {
    if (field === "effectKind") {
      if (value !== "dispatch_submit" && value !== "dispatch_cancel")
        throw new GatewayContractError("invalid_gateway_request", field);
    } else {
      assertIdentifier(value, field);
    }
  }
}

export function mutationFenceComparisonFields(
  fence: MutationFence,
): Readonly<Record<string, string | number | null>> {
  validateMutationFence(fence);
  return Object.freeze({
    allocationId: fence.allocationId ?? null,
    attemptId: fence.attemptId,
    clusterIncarnation: fence.clusterIncarnation,
    clusterIncarnationVersion: fence.clusterIncarnationVersion,
    desiredEffect: fence.desiredEffect,
    effectScopeKey: fence.effectScopeKey,
    executionGeneration: fence.executionGeneration,
    expectedDesiredVersion: fence.expectedDesiredVersion,
    issuedStartRevocationRevision: fence.issuedStartRevocationRevision ?? null,
    namespaceId: fence.namespaceId,
    namespaceWriterEpoch: fence.namespaceWriterEpoch,
    nodeBootEpoch: fence.nodeBootEpoch ?? null,
    nodeId: fence.nodeId ?? null,
    notAfter: fence.notAfter ?? null,
    notBefore: fence.notBefore ?? null,
    operationGateRevision: fence.operationGateRevision,
    ownerFence: fence.ownerFence ?? null,
    requiredGate: fence.requiredGate,
    schemaVersion: fence.schemaVersion,
    startFence: fence.startFence ?? null,
    supersessionKey: fence.supersessionKey,
  });
}

export function validateFenceForSchedulerScope(
  fence: MutationFence,
  scope: SchedulerMutationScope,
): void {
  validateClosedMutationFence(fence);
  validateMutationFence(fence);
  validateSchedulerMutationScope(scope);
  if (
    fence.namespaceId !== scope.namespaceId ||
    fence.desiredEffect !== scope.effectKind ||
    fence.attemptId !== scope.attemptId ||
    fence.executionGeneration !== scope.executionGeneration ||
    fence.allocationId !== scope.allocationId ||
    fence.effectScopeKey !== `scheduler-dispatch:${scope.dispatchId}`
  )
    throw new GatewayContractError("invalid_gateway_request", "scope_fence");
  if (
    scope.effectKind === "dispatch_submit" &&
    (fence.requiredGate !== "dispatch_submit" ||
      fence.startFence === undefined ||
      fence.issuedStartRevocationRevision === undefined)
  )
    throw new GatewayContractError("invalid_gateway_request", "submit_fence");
  if (
    scope.effectKind === "dispatch_cancel" &&
    (fence.requiredGate !== "dispatch_cancel" ||
      fence.startFence !== undefined ||
      fence.issuedStartRevocationRevision !== undefined)
  )
    throw new GatewayContractError("invalid_gateway_request", "cancel_fence");
}

function validateAcknowledgementBindings(
  request: MutateHyperQueueRequest,
): void {
  validateAcknowledgementStructure(
    request.acknowledgedInstall,
    "install_acknowledgement",
  );
  if (request.submitRevocationAcknowledgement !== undefined)
    validateAcknowledgementStructure(
      request.submitRevocationAcknowledgement,
      "submit_revocation_acknowledgement",
    );
  const acknowledgement = request.acknowledgedInstall.claims;
  if (
    !sameDispatchIdentity(acknowledgement.scope, request.scope) ||
    acknowledgement.scope.effectKind !== request.scope.effectKind ||
    (acknowledgement.result !== "installed" &&
      acknowledgement.result !== "already_installed") ||
    acknowledgement.drainDisposition !== "drained"
  )
    throw new GatewayContractError(
      "invalid_gateway_request",
      "install_ack_binding",
    );
  const revocation = request.submitRevocationAcknowledgement?.claims;
  if (request.scope.effectKind === "dispatch_submit") {
    if (revocation !== undefined)
      throw new GatewayContractError(
        "invalid_gateway_request",
        "unexpected_submit_revocation_ack",
      );
    return;
  }
  if (
    revocation === undefined ||
    !sameDispatchIdentity(revocation.scope, request.scope) ||
    revocation.scope.effectKind !== "dispatch_submit" ||
    (revocation.result !== "installed" &&
      revocation.result !== "already_installed") ||
    revocation.drainDisposition !== "drained" ||
    !Number.isSafeInteger(
      revocation.comparisonFields["issuedStartRevocationRevision"],
    ) ||
    (revocation.comparisonFields["issuedStartRevocationRevision"] as number) < 1
  )
    throw new GatewayContractError(
      "invalid_gateway_request",
      "submit_revocation_ack_binding",
    );
}

export function validateMutationPayload(
  payload: HyperQueueMutation,
  scope: SchedulerMutationScope,
): void {
  if (payload.dispatchId !== scope.dispatchId)
    throw new GatewayContractError("invalid_gateway_request", "dispatch_id");
  assertIdentifier(payload.mappingFingerprint, "mapping_fingerprint");
  if (scope.effectKind === "dispatch_submit") {
    validateSubmitPayload(payload);
  } else {
    validateCancelPayload(payload);
  }
}

function validateSubmitPayload(payload: HyperQueueMutation): void {
  if (payload.kind !== "submit")
    throw new GatewayContractError("invalid_gateway_request", "submit_payload");
  exactKeys(
    payload,
    [
      "dispatchId",
      "kind",
      "mappingFingerprint",
      "requestedCpuCount",
      "requiredCustomResources",
      "restartPolicy",
      "shimInvocationBase64",
    ],
    "submit_payload",
  );
  const restartPolicy: unknown = payload.restartPolicy;
  if (restartPolicy !== "never")
    throw new GatewayContractError("invalid_gateway_request", "submit_payload");
  assertPositive(payload.requestedCpuCount, "requested_cpu_count");
  const shimInvocationBase64: unknown = payload.shimInvocationBase64;
  if (
    typeof shimInvocationBase64 !== "string" ||
    shimInvocationBase64.length < 1 ||
    shimInvocationBase64.length > 256 * 1024 ||
    !/^[A-Za-z0-9_-]+$/u.test(shimInvocationBase64)
  )
    throw new GatewayContractError("invalid_gateway_request", "shim_payload");
  const resources: unknown = payload.requiredCustomResources;
  if (
    typeof resources !== "object" ||
    resources === null ||
    Array.isArray(resources) ||
    Object.keys(resources).length > 32
  )
    throw new GatewayContractError(
      "invalid_gateway_request",
      "custom_resources",
    );
  for (const [key, value] of Object.entries(resources)) {
    assertIdentifier(key, "custom_resource");
    assertPositive(value, "custom_resource_value");
  }
}

function validateCancelPayload(payload: HyperQueueMutation): void {
  if (payload.kind !== "cancel")
    throw new GatewayContractError("invalid_gateway_request", "cancel_payload");
  exactKeys(
    payload,
    ["dispatchId", "jobId", "kind", "mappingFingerprint", "taskId"],
    "cancel_payload",
  );
  assertIdentifier(payload.jobId, "job_id");
  assertIdentifier(payload.taskId, "task_id");
}

export function validateMutationRequest(
  request: MutateHyperQueueRequest,
): void {
  const hasSubmitRevocation = request.scope.effectKind === "dispatch_cancel";
  exactKeys(
    request,
    [
      "acknowledgedInstall",
      "mutationFence",
      "mutationFenceFingerprint",
      "operationId",
      "payload",
      "protocolVersion",
      "scope",
      ...(hasSubmitRevocation ? ["submitRevocationAcknowledgement"] : []),
    ],
    "mutation_request",
  );
  const protocolVersion: unknown = request.protocolVersion;
  if (protocolVersion !== SCHEDULER_GATEWAY_PROTOCOL)
    throw new GatewayContractError("invalid_gateway_request", "protocol");
  assertIdentifier(request.operationId, "operation_id");
  validateFenceForSchedulerScope(request.mutationFence, request.scope);
  if (
    fingerprintMutationFence(request.mutationFence) !==
    request.mutationFenceFingerprint
  )
    throw new GatewayContractError("invalid_gateway_request", "fingerprint");
  validateAcknowledgementBindings(request);
  validateMutationPayload(request.payload, request.scope);
}

export function snapshotMutationRequest(
  request: MutateHyperQueueRequest,
): MutateHyperQueueRequest {
  const snapshot = structuredClone(request);
  validateMutationRequest(snapshot);
  return deepFreeze(snapshot);
}

export function authorizeHyperQueueMutation(
  request: MutateHyperQueueRequest,
  registrySequence: number,
  requestFingerprint: string,
  canonicalJobName?: string,
): AuthorizedHyperQueueMutation {
  validateMutationRequest(request);
  assertPositive(registrySequence, "registry_sequence");
  if (!/^[a-f0-9]{64}$/u.test(requestFingerprint))
    throw new GatewayContractError(
      "invalid_gateway_request",
      "request_fingerprint",
    );
  if (
    (request.payload.kind === "submit" && canonicalJobName === undefined) ||
    (request.payload.kind === "cancel" && canonicalJobName !== undefined)
  )
    throw new GatewayContractError(
      "invalid_gateway_request",
      "canonical_job_name",
    );
  return Object.freeze({
    [authorizedMutationBrand]: true as const,
    ...(canonicalJobName === undefined ? {} : { canonicalJobName }),
    registrySequence,
    request,
    requestFingerprint,
  });
}
