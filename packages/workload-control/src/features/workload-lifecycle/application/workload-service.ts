import type { CanonicalCoordinator } from "@workload-funnel/workload-control/canonical-transaction-coordination";

import type { LifecycleRepository } from "./contracts/lifecycle-repository.js";
import { validateWorkloadSpec, workloadSpecDigest } from "./workload-spec.js";
import {
  authenticatedCallerScope,
  lifecycleOperationId,
} from "./caller-identity.js";
import {
  validateAuthenticatedPrincipal,
  validateLifecycleErasureAuthority,
  validateLifecycleErasureInput,
  validateLifecycleText,
} from "./lifecycle-input-validation.js";
import type {
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  WorkloadSpec,
  WorkloadStatus,
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

export function createWorkloadLifecycleService(
  repository: LifecycleRepository,
  coordinator: CanonicalCoordinator,
): WorkloadLifecycleService {
  const service: WorkloadLifecycleService = {
    submit(principal, command) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(
        command.idempotencyKey,
        512,
        "Idempotency key is invalid",
      );
      const spec = validateWorkloadSpec(command.spec);
      const callerScope = authenticatedCallerScope(principal);
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
          specDigest: workloadSpecDigest(spec),
        });
        return receipt;
      }
      const operationId = lifecycleOperationId(
        "submit",
        callerScope,
        command.idempotencyKey,
      );
      return coordinator.execute("accept-workload-v1", operationId, () =>
        repository.accept({
          callerScope,
          idempotencyKey: command.idempotencyKey,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
          spec,
          specDigest: workloadSpecDigest(spec),
        }),
      );
    },
    cancel(principal, runId, idempotencyKey) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(runId, 512, "Run identity is invalid");
      validateLifecycleText(idempotencyKey, 512, "Idempotency key is invalid");
      const callerScope = authenticatedCallerScope(principal);
      const operationId = lifecycleOperationId(
        "cancel",
        callerScope,
        idempotencyKey,
      );
      const prior = repository.getOperation(callerScope, operationId);
      if (prior !== undefined)
        return repository.cancel(callerScope, runId, operationId);
      return repository.cancel(callerScope, runId, operationId);
    },
    status(principal, runId) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(runId, 512, "Run identity is invalid");
      return repository.getStatus(authenticatedCallerScope(principal), runId);
    },
    operationStatus(principal, operationId) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(operationId, 2048, "Operation identity is invalid");
      return repository.getOperation(
        authenticatedCallerScope(principal),
        operationId,
      );
    },
    erasePrincipalReferences(principal, input) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleErasureInput(input);
      validateLifecycleErasureAuthority(principal, input);
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
