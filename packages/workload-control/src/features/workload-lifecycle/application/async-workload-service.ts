import type {
  AsyncLifecycleCallOptions,
  AsyncLifecycleRepository,
} from "./contracts/async-lifecycle-repository.js";
import type {
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  WorkloadStatus,
} from "../domain/workload-records.js";
import type {
  AuthenticatedPrincipal,
  SubmitCommand,
} from "./workload-service.js";
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

export interface AsyncWorkloadLifecycleService {
  submit(
    principal: AuthenticatedPrincipal,
    command: SubmitCommand,
    options?: AsyncLifecycleCallOptions,
  ): Promise<AcceptanceReceipt>;
  cancel(
    principal: AuthenticatedPrincipal,
    runId: string,
    idempotencyKey: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<CancellationReceipt>;
  status(
    principal: AuthenticatedPrincipal,
    runId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<WorkloadStatus | undefined>;
  operationStatus(
    principal: AuthenticatedPrincipal,
    operationId: string,
    options?: AsyncLifecycleCallOptions,
  ): Promise<OperationStatus | undefined>;
  erasePrincipalReferences(
    principal: AuthenticatedPrincipal,
    input: {
      readonly operationId: string;
      readonly subjectPrincipalId: string;
      readonly pseudonym: string;
    },
    options?: AsyncLifecycleCallOptions,
  ): Promise<number>;
  applyAttempt(
    attempt: Attempt,
    expectedVersion: number,
    options?: AsyncLifecycleCallOptions,
  ): Promise<void>;
  applyRun(
    run: Run,
    expectedVersion: number,
    options?: AsyncLifecycleCallOptions,
  ): Promise<void>;
}

export function createAsyncWorkloadLifecycleService(
  repository: AsyncLifecycleRepository,
): AsyncWorkloadLifecycleService {
  const service: AsyncWorkloadLifecycleService = {
    applyAttempt: (attempt, expectedVersion, options) =>
      repository.saveAttempt(attempt, expectedVersion, options),
    applyRun: (run, expectedVersion, options) =>
      repository.saveRun(run, expectedVersion, options),
    cancel(principal, runId, idempotencyKey, options) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(runId, 512, "Run identity is invalid");
      validateLifecycleText(idempotencyKey, 512, "Idempotency key is invalid");
      const callerScope = authenticatedCallerScope(principal);
      return repository.cancel(
        callerScope,
        runId,
        lifecycleOperationId("cancel", callerScope, idempotencyKey),
        options,
      );
    },
    erasePrincipalReferences(principal, input, options) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleErasureInput(input);
      validateLifecycleErasureAuthority(principal, input);
      return repository.erasePrincipalReferences(
        { ...input, tenantId: principal.tenantId },
        options,
      );
    },
    operationStatus(principal, operationId, options) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(operationId, 2048, "Operation identity is invalid");
      return repository.getOperation(
        authenticatedCallerScope(principal),
        operationId,
        options,
      );
    },
    status(principal, runId, options) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(runId, 512, "Run identity is invalid");
      return repository.getStatus(
        authenticatedCallerScope(principal),
        runId,
        options,
      );
    },
    submit(principal, command, options) {
      validateAuthenticatedPrincipal(principal);
      validateLifecycleText(
        command.idempotencyKey,
        512,
        "Idempotency key is invalid",
      );
      const spec = validateWorkloadSpec(command.spec);
      return repository.accept(
        {
          callerScope: authenticatedCallerScope(principal),
          idempotencyKey: command.idempotencyKey,
          principalId: principal.principalId,
          spec,
          specDigest: workloadSpecDigest(spec),
          tenantId: principal.tenantId,
        },
        options,
      );
    },
  };
  return Object.freeze(service);
}
