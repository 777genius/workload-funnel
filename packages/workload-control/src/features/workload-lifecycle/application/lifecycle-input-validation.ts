import { InvalidWorkloadError } from "../domain/workload-records.js";
import {
  isWellFormedLifecycleText,
  type LifecycleCallerIdentity,
} from "./caller-identity.js";

export interface LifecycleErasureInput {
  readonly operationId: string;
  readonly pseudonym: string;
  readonly subjectPrincipalId: string;
}

export function validateLifecycleText(
  value: unknown,
  maximum: number,
  code: string,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes("\0") ||
    !isWellFormedLifecycleText(value)
  )
    throw new InvalidWorkloadError(code);
}

export function validateAuthenticatedPrincipal(
  value: unknown,
): asserts value is LifecycleCallerIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidWorkloadError("Authenticated principal is invalid");
  const principal = value as Record<string, unknown>;
  validateLifecycleText(
    principal["namespaceId"],
    255,
    "Authenticated namespace is invalid",
  );
  validateLifecycleText(
    principal["principalId"],
    255,
    "Authenticated principal is invalid",
  );
  validateLifecycleText(
    principal["tenantId"],
    255,
    "Authenticated tenant is invalid",
  );
}

export function validateLifecycleErasureInput(
  value: unknown,
): asserts value is LifecycleErasureInput {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidWorkloadError("Erasure request is invalid");
  const input = value as Record<string, unknown>;
  validateLifecycleText(
    input["operationId"],
    512,
    "Erasure operation identity is invalid",
  );
  validateLifecycleText(
    input["subjectPrincipalId"],
    255,
    "Erasure subject is invalid",
  );
  validateLifecycleText(
    input["pseudonym"],
    255,
    "Erasure pseudonym is invalid",
  );
}

export function validateLifecycleErasureAuthority(
  principal: LifecycleCallerIdentity,
  input: LifecycleErasureInput,
): void {
  if (input.subjectPrincipalId !== principal.principalId)
    throw new InvalidWorkloadError(
      "Erasure subject is not authorized for this principal",
    );
}
