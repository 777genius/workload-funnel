import type { CanonicalCoordinator } from "@workload-funnel/workload-control/canonical-transaction-coordination";

import type { LifecycleRepository } from "./contracts/lifecycle-repository.js";
import {
  InvalidWorkloadError,
  type AcceptanceReceipt,
  type Attempt,
  type CancellationReceipt,
  type OperationStatus,
  type Run,
  type WorkloadSpec,
  type WorkloadStatus,
} from "../domain/workload-records.js";

export interface AuthenticatedPrincipal {
  readonly principalId: "synthetic-principal";
  readonly tenantId: "synthetic-tenant";
  readonly namespaceId: string;
}

export interface SubmitCommand {
  readonly idempotencyKey: string;
  readonly spec: WorkloadSpec;
}

export interface WorkloadLifecycleService {
  submit(
    principal: AuthenticatedPrincipal,
    command: SubmitCommand,
  ): AcceptanceReceipt;
  cancel(
    principal: AuthenticatedPrincipal,
    runId: string,
    idempotencyKey: string,
  ): CancellationReceipt;
  status(
    principal: AuthenticatedPrincipal,
    runId: string,
  ): WorkloadStatus | undefined;
  operationStatus(
    principal: AuthenticatedPrincipal,
    operationId: string,
  ): OperationStatus | undefined;
  applyAttempt(attempt: Attempt): void;
  applyRun(run: Run): void;
}

function validateSpec(value: unknown): asserts value is WorkloadSpec {
  if (typeof value !== "object" || value === null) {
    throw new InvalidWorkloadError("A structured WorkloadSpec is required");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate["schemaVersion"] !== 1 ||
    candidate["processProfile"] !== "trusted-synthetic-v1"
  ) {
    throw new InvalidWorkloadError(
      "Only the trusted synthetic v1 profile is enabled",
    );
  }
  const spec = value as WorkloadSpec;
  if (
    spec.command.length === 0 ||
    spec.command.some((part) => part.length === 0)
  ) {
    throw new InvalidWorkloadError(
      "A structured synthetic command is required",
    );
  }
  if (spec.resources.cpuMillis <= 0 || spec.resources.memoryMiB <= 0) {
    throw new InvalidWorkloadError("Resource requests must be positive");
  }
  for (const result of spec.resultFiles) {
    if (
      result.path.length === 0 ||
      result.path.startsWith("/") ||
      result.path.split("/").includes("..")
    ) {
      throw new InvalidWorkloadError(
        "Result paths must remain inside the synthetic root",
      );
    }
  }
}

function digestSpec(spec: WorkloadSpec): string {
  const value = JSON.stringify(spec);
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `spec-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function createWorkloadLifecycleService(
  repository: LifecycleRepository,
  coordinator: CanonicalCoordinator,
): WorkloadLifecycleService {
  const service: WorkloadLifecycleService = {
    submit(principal, command) {
      validateSpec(command.spec);
      const callerScope = `${principal.namespaceId}:${principal.principalId}`;
      const prior = repository.findOperation(
        callerScope,
        command.idempotencyKey,
      );
      if (prior !== undefined) {
        const receipt = repository.accept({
          callerScope,
          idempotencyKey: command.idempotencyKey,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          spec: command.spec,
          specDigest: digestSpec(command.spec),
        });
        return receipt;
      }
      const operationId = `submit:${callerScope}:${command.idempotencyKey}`;
      return coordinator.execute("accept-workload-v1", operationId, () =>
        repository.accept({
          callerScope,
          idempotencyKey: command.idempotencyKey,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          spec: command.spec,
          specDigest: digestSpec(command.spec),
        }),
      );
    },
    cancel(principal, runId, idempotencyKey) {
      const operationId = `cancel:${principal.namespaceId}:${principal.principalId}:${idempotencyKey}`;
      const prior = repository.getOperation(operationId);
      if (prior !== undefined) return repository.cancel(runId, operationId);
      return repository.cancel(runId, operationId);
    },
    status: (_principal, runId) => repository.getStatus(runId),
    operationStatus: (_principal, operationId) =>
      repository.getOperation(operationId),
    applyAttempt: (attempt) => {
      repository.saveAttempt(attempt);
    },
    applyRun: (run) => {
      repository.saveRun(run);
    },
  };
  return Object.freeze(service);
}
