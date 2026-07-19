import type {
  AsyncLifecycleCallOptions,
  AsyncLifecycleRepository,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { acceptPostgresLifecycle } from "./acceptance.js";
import { cancelPostgresLifecycle } from "./cancellation.js";
import { LifecycleReads } from "./lifecycle-reads.js";
import { LifecycleWrites } from "./lifecycle-writes.js";
import {
  type PostgresLifecycleDatabaseConfig,
  validatePostgresLifecycleConfig,
} from "./postgres-config.js";
import { sanitizePostgresError } from "./postgres-errors.js";
import {
  type PostgresLifecycleFaultInjector,
  type PostgresLifecycleMigrationExecutor,
  type PostgresLifecycleTraceSink,
  type PostgresAsyncQueryExecutor,
  postgresLifecycleDriverVersion,
  PostgresPoolRuntime,
} from "./postgres-pool.js";

export interface PostgresLifecycleDatabase {
  readonly driverVersion: typeof postgresLifecycleDriverVersion;
  readonly migrationExecutor: PostgresLifecycleMigrationExecutor;
  readonly queryExecutor: PostgresAsyncQueryExecutor;
  readonly profile: PostgresLifecycleDatabaseConfig["profile"];
  readonly repository: AsyncLifecycleRepository;
  readonly schema: string;
  readonly schemaOwner: string;
  close(): Promise<void>;
}

export interface PostgresLifecycleDatabaseFactoryInput {
  readonly config: PostgresLifecycleDatabaseConfig;
  readonly faults?: PostgresLifecycleFaultInjector;
  readonly trace?: PostgresLifecycleTraceSink;
}

function signal(options?: AsyncLifecycleCallOptions): AbortSignal | undefined {
  return options?.signal;
}

async function safe<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw sanitizePostgresError(error);
  }
}

export function createPostgresLifecycleDatabase(
  input: PostgresLifecycleDatabaseFactoryInput,
): PostgresLifecycleDatabase {
  const config = validatePostgresLifecycleConfig(input.config);
  const pool = new PostgresPoolRuntime(config);
  const reads = new LifecycleReads(pool, config.schema);
  const writes = new LifecycleWrites(pool, config.schema);
  const runtime = Object.freeze({
    ...(input.faults === undefined ? {} : { faults: input.faults }),
    pool,
    schema: config.schema,
    ...(input.trace === undefined ? {} : { trace: input.trace }),
  });
  const repository: AsyncLifecycleRepository = {
    accept: (command, options) =>
      acceptPostgresLifecycle(runtime, command, signal(options)),
    cancel: (callerScope, runId, operationId, options) =>
      cancelPostgresLifecycle(
        runtime,
        callerScope,
        runId,
        operationId,
        signal(options),
      ),
    erasePrincipalReferences: (command, options) =>
      safe(() => writes.erasePrincipalReferences(command, signal(options))),
    findOperation: (callerScope, idempotencyKey, options) =>
      reads.findOperation(callerScope, idempotencyKey, signal(options)),
    getAttempt: (attemptId, options) =>
      reads.getAttempt(attemptId, signal(options)),
    getCancellation: (operationId, options) =>
      reads.getCancellation(operationId, signal(options)),
    getOperation: (callerScope, operationId, options) =>
      reads.getOperation(callerScope, operationId, signal(options)),
    getRun: (runId, options) => reads.getRun(runId, signal(options)),
    getStatus: (callerScope, runId, options) =>
      reads.getStatus(callerScope, runId, signal(options)),
    getWorkload: (workloadId, options) =>
      reads.getWorkload(workloadId, signal(options)),
    saveAttempt: (attempt, expectedVersion, options) =>
      safe(() => writes.saveAttempt(attempt, expectedVersion, signal(options))),
    saveRun: (run, expectedVersion, options) =>
      safe(() => writes.saveRun(run, expectedVersion, signal(options))),
  };
  return Object.freeze({
    close: () => pool.close(),
    driverVersion: postgresLifecycleDriverVersion,
    migrationExecutor: pool.migrationExecutor,
    queryExecutor: pool.queryExecutor,
    profile: config.profile,
    repository: Object.freeze(repository),
    schema: config.schema,
    schemaOwner: config.schemaOwner,
  });
}
