import type {
  AcceptanceInput,
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  LifecyclePersistenceFactoryInput,
  LifecycleRepository,
  Run,
  Workload,
} from "@workload-funnel/workload-control/workload-lifecycle";

export function createPostgresLifecycleRepository(
  input: LifecyclePersistenceFactoryInput,
): LifecycleRepository {
  const { hooks, state } = input;
  return {
    accept(command: AcceptanceInput): AcceptanceReceipt {
      const key = `${command.callerScope}:${command.idempotencyKey}`;
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
      const operationId = `submit:${command.callerScope}:${command.idempotencyKey}`;
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
      hooks.accepted({ attemptId, operationId, runId, workloadId });
      return receipt;
    },
    cancel(runId, operationId): CancellationReceipt {
      const run = state.runById.get(runId);
      if (run === undefined) throw new Error("Run does not exist");
      const prior = state.cancellationReceiptByOperation.get(operationId);
      if (prior !== undefined) return prior;
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
      const receipt = Object.freeze({
        operationId,
        runId,
        status: terminal ? "already_terminal" : "cancellation_requested",
      });
      state.cancellationReceiptByOperation.set(operationId, receipt);
      return receipt;
    },
    findOperation: (callerScope, idempotencyKey) =>
      state.operationById.get(`submit:${callerScope}:${idempotencyKey}`),
    getOperation: (operationId) => state.operationById.get(operationId),
    getStatus(runId) {
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
