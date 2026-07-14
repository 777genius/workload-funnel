import { DatabaseSync } from "node:sqlite";

import type {
  AcceptanceInput,
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  LifecyclePersistenceFactoryInput,
  LifecycleRepository,
  Run,
  Workload,
  DisasterRecoveryOperation,
  DisasterRecoveryStore,
} from "@workload-funnel/workload-control/workload-lifecycle";

export function createSqliteLifecycleRepository(
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
      if (prior !== undefined) {
        if (prior.runId !== runId) throw new Error("idempotency_key_conflict");
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
      if (prior !== undefined) return prior;
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
      state.lifecycleErasureByOperation.set(command.operationId, changed);
      return changed;
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

export interface OpenSqliteDisasterRecoveryStore {
  readonly store: DisasterRecoveryStore;
  close(): void;
}

interface DisasterRecoveryPayloadRow {
  readonly payload: string;
}

function migrateDisasterRecovery(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS disaster_recovery_operation (
      operation_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0),
      step TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
  `);
}

function getDisasterRecoveryOperation(
  database: DatabaseSync,
  operationId: string,
): DisasterRecoveryOperation | undefined {
  const row = database
    .prepare(
      "SELECT payload FROM disaster_recovery_operation WHERE operation_id = ?",
    )
    .get(operationId) as DisasterRecoveryPayloadRow | undefined;
  return row === undefined
    ? undefined
    : (JSON.parse(row.payload) as DisasterRecoveryOperation);
}

export function createSqliteDisasterRecoveryStore(
  database: DatabaseSync,
): DisasterRecoveryStore {
  migrateDisasterRecovery(database);
  const store: DisasterRecoveryStore = {
    compareAndSet(expectedVersion, operation) {
      if (
        operation.version !== expectedVersion + 1 ||
        database
          .prepare(
            "UPDATE disaster_recovery_operation SET version = ?, step = ?, payload = ? WHERE operation_id = ? AND version = ?",
          )
          .run(
            operation.version,
            operation.step,
            JSON.stringify(operation),
            operation.operationId,
            expectedVersion,
          ).changes !== 1
      )
        throw new Error("sqlite_disaster_recovery_version_conflict");
      return operation;
    },
    create(operation) {
      const inserted = database
        .prepare(
          "INSERT INTO disaster_recovery_operation (operation_id, version, step, payload) VALUES (?, ?, ?, ?) ON CONFLICT(operation_id) DO NOTHING",
        )
        .run(
          operation.operationId,
          operation.version,
          operation.step,
          JSON.stringify(operation),
        ).changes;
      if (inserted === 1) return operation;
      const prior = getDisasterRecoveryOperation(
        database,
        operation.operationId,
      );
      if (
        prior === undefined ||
        JSON.stringify(prior) !== JSON.stringify(operation)
      )
        throw new Error("sqlite_disaster_recovery_create_conflict");
      return prior;
    },
    get: (operationId) => getDisasterRecoveryOperation(database, operationId),
  };
  return Object.freeze(store);
}

export function openSqliteDisasterRecoveryStore(
  path: string,
): OpenSqliteDisasterRecoveryStore {
  const database = new DatabaseSync(path);
  return Object.freeze({
    close: () => {
      database.close();
    },
    store: createSqliteDisasterRecoveryStore(database),
  });
}
