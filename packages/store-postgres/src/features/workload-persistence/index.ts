import {
  lifecycleIdempotencyStorageKey,
  lifecycleOperationId,
  type AcceptanceInput,
  type AcceptanceReceipt,
  type Attempt,
  type CancellationReceipt,
  type LifecyclePersistenceFactoryInput,
  type LifecycleRepository,
  type Run,
  type Workload,
} from "@workload-funnel/workload-control/workload-lifecycle";

export function createPostgresLifecycleRepository(
  input: LifecyclePersistenceFactoryInput,
): LifecycleRepository {
  const { hooks, state } = input;
  return {
    accept(command: AcceptanceInput): AcceptanceReceipt {
      const key = lifecycleIdempotencyStorageKey(
        command.callerScope,
        command.idempotencyKey,
      );
      const prior = state.acceptanceByKey.get(key);
      if (prior !== undefined) {
        if (state.acceptanceDigestByKey.get(key) !== command.specDigest) {
          throw new Error(
            "Idempotency key is already bound to a different WorkloadSpec",
          );
        }
        return prior;
      }
      const suffix = String(++state.sequence).padStart(4, "0");
      const workloadId = `workload-${suffix}`;
      const runId = `run-${suffix}`;
      const attemptId = `attempt-${suffix}`;
      const executionGeneration = `generation-${suffix}`;
      const operationId = lifecycleOperationId(
        "submit",
        command.callerScope,
        command.idempotencyKey,
      );
      const workload: Workload = Object.freeze({
        principalId: command.principalId,
        spec: command.spec,
        specDigest: command.specDigest,
        tenantId: command.tenantId,
        workloadId,
      });
      const run: Run = Object.freeze({
        attemptId,
        cancellationDesired: "none",
        runId,
        state: "accepted",
        version: 1,
        workloadId,
      });
      const attempt: Attempt = Object.freeze({
        attachmentRejections: 0,
        attemptId,
        cancellationDesired: "none",
        executionGeneration,
        reservationRequestRevision: 0,
        runId,
        startFence: `start-fence-${suffix}`,
        startAuthorization: "authorized",
        startRevocationRevision: 0,
        state: "queued",
        version: 1,
      });
      const receipt = Object.freeze({
        attemptId,
        duplicate: false,
        executionGeneration,
        operationId,
        runId,
        workloadId,
      });
      state.workloadById.set(workloadId, workload);
      state.runById.set(runId, run);
      state.attemptById.set(attemptId, attempt);
      state.acceptanceByKey.set(key, receipt);
      state.acceptanceDigestByKey.set(key, command.specDigest);
      state.operationById.set(
        operationId,
        Object.freeze({
          kind: "submit",
          operationId,
          resourceId: runId,
          status: "committed",
        }),
      );
      state.callerScopeByOperationId.set(operationId, command.callerScope);
      state.callerScopeByRunId.set(runId, command.callerScope);
      hooks.accepted({ attemptId, operationId, runId, workloadId });
      return receipt;
    },
    cancel(callerScope, runId, operationId): CancellationReceipt {
      const run = state.runById.get(runId);
      if (
        run === undefined ||
        state.callerScopeByRunId.get(runId) !== callerScope
      )
        throw new Error("Run does not exist");
      const prior = state.cancellationReceiptByOperation.get(operationId);
      if (prior !== undefined) {
        if (
          prior.runId !== runId ||
          state.callerScopeByOperationId.get(operationId) !== callerScope
        )
          throw new Error("idempotency_key_conflict");
        return prior;
      }
      const terminal = run.terminalOutcome !== undefined;
      if (!terminal) {
        state.runById.set(
          runId,
          Object.freeze({
            ...run,
            cancellationDesired: "requested",
            version: run.version + 1,
          }),
        );
        const attempt = state.attemptById.get(run.attemptId);
        if (attempt !== undefined) {
          state.attemptById.set(
            attempt.attemptId,
            Object.freeze({
              ...attempt,
              cancellationDesired: "requested",
              version: attempt.version + 1,
            }),
          );
        }
        state.cancelOperationByRun.set(runId, operationId);
        hooks.cancellationRequested({
          attemptId: run.attemptId,
          operationId,
          runId,
        });
      }
      state.operationById.set(
        operationId,
        Object.freeze({
          kind: "cancel",
          operationId,
          resourceId: runId,
          status: "committed",
        }),
      );
      state.callerScopeByOperationId.set(operationId, callerScope);
      const receipt = Object.freeze({
        operationId,
        runId,
        status: terminal ? "already_terminal" : "cancellation_requested",
      });
      state.cancellationReceiptByOperation.set(operationId, receipt);
      return receipt;
    },
    erasePrincipalReferences(command) {
      const prior = state.lifecycleErasureByOperation.get(command.operationId);
      if (prior !== undefined) {
        if (
          prior.tenantId !== command.tenantId ||
          prior.subjectPrincipalId !== command.subjectPrincipalId ||
          prior.pseudonym !== command.pseudonym
        )
          throw new Error("idempotency_key_conflict");
        return prior.changedCount;
      }
      let changed = 0;
      for (const [workloadId, workload] of state.workloadById) {
        if (
          workload.tenantId !== command.tenantId ||
          workload.principalId !== command.subjectPrincipalId
        )
          continue;
        state.workloadById.set(
          workloadId,
          Object.freeze({
            ...workload,
            principalId: command.pseudonym,
            spec: Object.freeze({
              ...workload.spec,
              command: Object.freeze(["[erased]"]),
              resultFiles: Object.freeze([]),
            }),
          }),
        );
        changed += 1;
      }
      state.lifecycleErasureByOperation.set(
        command.operationId,
        Object.freeze({
          changedCount: changed,
          pseudonym: command.pseudonym,
          subjectPrincipalId: command.subjectPrincipalId,
          tenantId: command.tenantId,
        }),
      );
      return changed;
    },
    findOperation: (callerScope, idempotencyKey) =>
      state.operationById.get(
        lifecycleOperationId("submit", callerScope, idempotencyKey),
      ),
    getOperation: (callerScope, operationId) =>
      state.callerScopeByOperationId.get(operationId) === callerScope
        ? state.operationById.get(operationId)
        : undefined,
    getStatus(callerScope, runId) {
      if (state.callerScopeByRunId.get(runId) !== callerScope) return undefined;
      const run = state.runById.get(runId);
      if (run === undefined) return undefined;
      const workload = state.workloadById.get(run.workloadId);
      const attempt = state.attemptById.get(run.attemptId);
      return workload === undefined || attempt === undefined
        ? undefined
        : Object.freeze({ attempt, run, workload });
    },
    getWorkload: (workloadId) => state.workloadById.get(workloadId),
    saveAttempt: (attempt) => state.attemptById.set(attempt.attemptId, attempt),
    saveRun(run) {
      state.runById.set(run.runId, run);
      hooks.projectRun(run);
    },
  };
}

export {
  createPostgresLifecycleDatabase,
  type PostgresLifecycleDatabase,
  type PostgresLifecycleDatabaseFactoryInput,
} from "./postgres-database.js";
export {
  type PostgresLifecycleDatabaseConfig,
  type PostgresLifecycleDisposableConfig,
  type PostgresLifecycleProductionConfig,
  PostgresLifecycleConfigurationError,
  validatePostgresLifecycleConfig,
} from "./postgres-config.js";
export {
  PostgresLifecycleError,
  type PostgresLifecycleErrorCode,
} from "./postgres-errors.js";
export type {
  PostgresLifecycleFaultBoundary,
  PostgresLifecycleFaultInjector,
  PostgresLifecycleMigrationExecutor,
  PostgresLifecycleTraceSink,
} from "./postgres-pool.js";
export { postgresLifecycleDriverVersion } from "./postgres-pool.js";
