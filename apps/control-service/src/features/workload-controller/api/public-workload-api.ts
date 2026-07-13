import type { AdmissionExplanation } from "@workload-funnel/workload-control/tenant-admission";
import type {
  AcceptanceReceipt,
  CancellationReceipt,
  OperationStatus,
  WorkloadSpec,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

export const MUTATION_CONTRACT_VERSION = "workload-funnel.mutation/v1" as const;
export const API_CONTRACT_VERSION = "workload-funnel.api/v1" as const;

export interface RequestAuthorizationContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly credentialId: string;
  readonly authorizationPolicyVersion: number;
  readonly authenticatedAt: number;
}

export interface MutationEnvelopeV1 {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly requestedTenantScope: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly expectedVersion?: number;
  readonly requiredExtensions?: readonly string[];
}

export interface PublicMutationContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly authorizationPolicyVersion: number;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly expectedVersion?: number;
}

export interface SubmitWorkloadRequestV1 {
  readonly contractVersion: string;
  readonly mutation: MutationEnvelopeV1;
  readonly spec: WorkloadSpec;
  readonly requiredExtensions?: readonly string[];
}

export interface CancelWorkloadRequestV1 {
  readonly contractVersion: string;
  readonly mutation: MutationEnvelopeV1;
  readonly reason: string;
  readonly requiredExtensions?: readonly string[];
}

export interface PublicOperationReceipt<T> {
  readonly contractVersion: typeof API_CONTRACT_VERSION;
  readonly operation: T;
}

export interface PublicWorkloadOperations {
  submit(context: PublicMutationContext, spec: WorkloadSpec): AcceptanceReceipt;
  observe(
    context: RequestAuthorizationContext,
    runId: string,
  ): WorkloadStatus | undefined;
  cancel(
    context: PublicMutationContext,
    runId: string,
    reason: string,
  ): CancellationReceipt;
  operation(
    context: RequestAuthorizationContext,
    operationId: string,
  ): OperationStatus | undefined;
  explanation(
    context: RequestAuthorizationContext,
    runId: string,
  ): AdmissionExplanation | undefined;
}

export interface PublicWorkloadController {
  submit(
    context: RequestAuthorizationContext,
    request: SubmitWorkloadRequestV1,
  ): PublicOperationReceipt<AcceptanceReceipt>;
  observe(
    context: RequestAuthorizationContext,
    runId: string,
  ): WorkloadStatus | undefined;
  cancel(
    context: RequestAuthorizationContext,
    runId: string,
    request: CancelWorkloadRequestV1,
  ): PublicOperationReceipt<CancellationReceipt>;
  operation(
    context: RequestAuthorizationContext,
    operationId: string,
  ): OperationStatus | undefined;
  explanation(
    context: RequestAuthorizationContext,
    runId: string,
  ): AdmissionExplanation | undefined;
}

export class InvalidApiContractError extends Error {
  public readonly code = "invalid_contract";

  public constructor(message: string) {
    super(message);
    this.name = "InvalidApiContractError";
  }
}

export class UnsupportedApiContractError extends Error {
  public readonly code = "unsupported_contract";

  public constructor(message: string) {
    super(message);
    this.name = "UnsupportedApiContractError";
  }
}

const identityFields = new Set([
  "actor",
  "actorId",
  "principal",
  "principalId",
  "effectiveTenant",
  "effectiveTenantId",
]);

function assertNoClaimedIdentity(value: unknown): void {
  const pending: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate !== "object" || candidate === null) continue;
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    for (const [key, nested] of Object.entries(candidate)) {
      if (identityFields.has(key))
        throw new InvalidApiContractError("caller_identity_field_forbidden");
      pending.push(nested);
    }
  }
}

function assertBoundedText(
  name: string,
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    /\p{Cc}/u.test(value)
  )
    throw new InvalidApiContractError(`invalid_${name}`);
}

export function validateMutationEnvelope(
  envelope: MutationEnvelopeV1,
  context: RequestAuthorizationContext,
): PublicMutationContext {
  assertNoClaimedIdentity(envelope);
  if (envelope.contractVersion !== MUTATION_CONTRACT_VERSION)
    throw new UnsupportedApiContractError("unsupported_mutation_contract");
  if (
    envelope.requiredExtensions !== undefined &&
    (!Array.isArray(envelope.requiredExtensions) ||
      envelope.requiredExtensions.length > 0)
  )
    throw new UnsupportedApiContractError("unsupported_required_extension");
  assertBoundedText("request_id", envelope.requestId);
  assertBoundedText("idempotency_key", envelope.idempotencyKey);
  assertBoundedText("requested_tenant_scope", envelope.requestedTenantScope);
  assertBoundedText("correlation_id", envelope.correlationId);
  assertBoundedText("causation_id", envelope.causationId);
  if (envelope.requestedTenantScope !== context.effectiveTenantId)
    throw new InvalidApiContractError("effective_tenant_mismatch");
  if (
    envelope.expectedVersion !== undefined &&
    (!Number.isSafeInteger(envelope.expectedVersion) ||
      envelope.expectedVersion < 0)
  )
    throw new InvalidApiContractError("invalid_expected_version");
  return Object.freeze({
    authorizationPolicyVersion: context.authorizationPolicyVersion,
    causationId: envelope.causationId,
    correlationId: envelope.correlationId,
    effectiveTenantId: context.effectiveTenantId,
    ...(envelope.expectedVersion === undefined
      ? {}
      : { expectedVersion: envelope.expectedVersion }),
    idempotencyKey: envelope.idempotencyKey,
    principalId: context.principalId,
    requestId: envelope.requestId,
  });
}

function validateApiRequest(
  request: SubmitWorkloadRequestV1 | CancelWorkloadRequestV1,
): void {
  assertNoClaimedIdentity(request);
  if (request.contractVersion !== API_CONTRACT_VERSION)
    throw new UnsupportedApiContractError("unsupported_api_contract");
  if (
    request.requiredExtensions !== undefined &&
    (!Array.isArray(request.requiredExtensions) ||
      request.requiredExtensions.length > 0)
  )
    throw new UnsupportedApiContractError("unsupported_required_extension");
}

export function createPublicWorkloadController(
  operations: PublicWorkloadOperations,
): PublicWorkloadController {
  const controller: PublicWorkloadController = {
    cancel(context, runId, request) {
      validateApiRequest(request);
      assertBoundedText("run_id", runId);
      assertBoundedText("cancellation_reason", request.reason);
      const mutation = validateMutationEnvelope(request.mutation, context);
      return Object.freeze({
        contractVersion: API_CONTRACT_VERSION,
        operation: operations.cancel(mutation, runId, request.reason),
      });
    },
    explanation: (context, runId) => operations.explanation(context, runId),
    observe: (context, runId) => operations.observe(context, runId),
    operation: (context, operationId) =>
      operations.operation(context, operationId),
    submit(context, request) {
      validateApiRequest(request);
      const mutation = validateMutationEnvelope(request.mutation, context);
      return Object.freeze({
        contractVersion: API_CONTRACT_VERSION,
        operation: operations.submit(mutation, request.spec),
      });
    },
  };
  return Object.freeze(controller);
}
