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
  readonly principalId: string;
  readonly tenantId: string;
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
  erasePrincipalReferences(
    principal: AuthenticatedPrincipal,
    input: {
      readonly operationId: string;
      readonly subjectPrincipalId: string;
      readonly pseudonym: string;
    },
  ): number;
  applyAttempt(attempt: Attempt): void;
  applyRun(run: Run): void;
}

function validateSpec(value: unknown): WorkloadSpec {
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
  const command = candidate["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.length > 128 ||
    command.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.length > 4096 ||
        part.includes("\0"),
    )
  ) {
    throw new InvalidWorkloadError(
      "A structured synthetic command is required",
    );
  }
  const commandParts = command as string[];
  if (commandParts.reduce((total, part) => total + part.length, 0) > 65_536)
    throw new InvalidWorkloadError(
      "A structured synthetic command is required",
    );
  const resources = candidate["resources"];
  if (typeof resources !== "object" || resources === null) {
    throw new InvalidWorkloadError("Resource requests must be positive");
  }
  const resourceRecord = resources as Record<string, unknown>;
  const cpuMillis = resourceRecord["cpuMillis"];
  const memoryMiB = resourceRecord["memoryMiB"];
  if (
    typeof cpuMillis !== "number" ||
    typeof memoryMiB !== "number" ||
    !Number.isSafeInteger(cpuMillis) ||
    !Number.isSafeInteger(memoryMiB) ||
    cpuMillis <= 0 ||
    memoryMiB <= 0 ||
    cpuMillis > 1_000_000_000 ||
    memoryMiB > 1_000_000_000
  )
    throw new InvalidWorkloadError("Resource requests must be positive");
  const syntheticOutcome = candidate["syntheticOutcome"];
  if (
    typeof syntheticOutcome !== "string" ||
    !["succeeded", "failed", "canceled"].includes(syntheticOutcome)
  )
    throw new InvalidWorkloadError("Synthetic outcome is not supported");
  const resultFiles = candidate["resultFiles"];
  if (!Array.isArray(resultFiles) || resultFiles.length > 256)
    throw new InvalidWorkloadError("Synthetic results exceed the file limit");
  let resultBytes = 0;
  for (const result of resultFiles) {
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result)
    ) {
      throw new InvalidWorkloadError(
        "Result paths must remain inside the synthetic root",
      );
    }
    const resultRecord = result as Record<string, unknown>;
    const path = resultRecord["path"];
    const content = resultRecord["content"];
    if (
      typeof path !== "string" ||
      typeof content !== "string" ||
      path.length === 0 ||
      path.length > 512 ||
      path.startsWith("/") ||
      path.split("/").includes("..") ||
      path.includes("\0") ||
      content.length > 1_048_576
    )
      throw new InvalidWorkloadError(
        "Result paths must remain inside the synthetic root",
      );
    resultBytes += content.length;
    if (resultBytes > 8_388_608)
      throw new InvalidWorkloadError("Synthetic result bytes exceed the limit");
  }
  return Object.freeze({
    command: Object.freeze([...commandParts]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis, memoryMiB }),
    resultFiles: Object.freeze(
      resultFiles.map((result) => {
        const record = result as Record<string, unknown>;
        return Object.freeze({
          content: record["content"] as string,
          path: record["path"] as string,
        });
      }),
    ),
    schemaVersion: 1,
    syntheticOutcome: syntheticOutcome as WorkloadSpec["syntheticOutcome"],
  });
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
      const spec = validateSpec(command.spec);
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
          spec,
          specDigest: digestSpec(spec),
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
          spec,
          specDigest: digestSpec(spec),
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
    erasePrincipalReferences(principal, input) {
      return repository.erasePrincipalReferences({
        ...input,
        tenantId: principal.tenantId,
      });
    },
    applyAttempt: (attempt) => {
      repository.saveAttempt(attempt);
    },
    applyRun: (run) => {
      repository.saveRun(run);
    },
  };
  return Object.freeze(service);
}
