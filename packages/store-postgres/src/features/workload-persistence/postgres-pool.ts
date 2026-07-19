import { Pool, type PoolClient } from "pg";

import type { PostgresLifecycleDatabaseConfig } from "./postgres-config.js";
import {
  ForcedConnectionTermination,
  isConnectionFailure,
  PostgresLifecycleError,
  sanitizePostgresError,
  TransactionFailure,
} from "./postgres-errors.js";

export const postgresLifecycleDriverVersion = "8.22.0" as const;

export type PostgresLifecycleFaultBoundary =
  | "after_begin"
  | "after_commit"
  | "after_writes"
  | "before_begin"
  | "before_commit";

export interface PostgresLifecycleFaultInjector {
  hit(
    input: Readonly<{
      backendProcessId: number;
      boundary: PostgresLifecycleFaultBoundary;
    }>,
  ): Promise<"terminate_connection" | undefined>;
}

export interface PostgresLifecycleTraceSink {
  append(event: string): void;
}

export interface PostgresQueryClient {
  readonly backendProcessId: number;
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresQueryResult<Row extends Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresLifecycleMigrationExecutor {
  transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T>;
}

interface TransactionOptions {
  readonly faults?: PostgresLifecycleFaultInjector;
  readonly isolationLevel?: "READ COMMITTED" | "SERIALIZABLE";
  readonly signal?: AbortSignal;
  readonly trace?: PostgresLifecycleTraceSink;
}

interface RuntimePoolClient extends PoolClient {
  readonly processID?: unknown;
}

function backendProcessId(client: PoolClient): number {
  const value = (client as RuntimePoolClient).processID;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new PostgresLifecycleError("postgres_lifecycle_operation_failed");
  return value;
}

function abortError(): PostgresLifecycleError {
  return new PostgresLifecycleError("postgres_lifecycle_aborted");
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  error: PostgresLifecycleError,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(error);
    }, timeoutMs);
    timer.unref();
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (failure: unknown) => {
        clearTimeout(timer);
        reject(
          failure instanceof Error
            ? failure
            : new PostgresLifecycleError("postgres_lifecycle_operation_failed"),
        );
      },
    );
  });
}

export class PostgresPoolRuntime {
  readonly #active = new Set<PoolClient>();
  readonly #config: PostgresLifecycleDatabaseConfig;
  readonly #destroyed = new WeakSet<PoolClient>();
  readonly #pool: Pool;
  readonly #shutdown = new AbortController();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  public constructor(config: PostgresLifecycleDatabaseConfig) {
    this.#config = config;
    this.#pool = new Pool({
      allowExitOnIdle: false,
      application_name: config.applicationName,
      connectionTimeoutMillis: config.connectionTimeoutMs + 25,
      database: config.database,
      host: config.host,
      idleTimeoutMillis: config.idleTimeoutMs,
      keepAlive: true,
      max: config.maxConnections,
      maxLifetimeSeconds: 300,
      password: config.password,
      port: config.port,
      query_timeout: config.queryTimeoutMs,
      statement_timeout: config.statementTimeoutMs,
      ssl:
        config.tls === false
          ? false
          : {
              ca: config.tls.certificateAuthority,
              minVersion: "TLSv1.2",
              rejectUnauthorized: true,
              servername: config.tls.serverName,
            },
      user: config.user,
    });
    this.#pool.on("error", () => {
      // Checked-out client failures are surfaced by their pending operation.
    });
  }

  public get migrationExecutor(): PostgresLifecycleMigrationExecutor {
    return Object.freeze({
      transaction: <T>(work: (client: PostgresQueryClient) => Promise<T>) =>
        this.transaction(
          (client) => work(client),
          Object.freeze({ isolationLevel: "READ COMMITTED" }),
        ).catch((error: unknown) => {
          if (error instanceof TransactionFailure) throw error.original;
          throw sanitizePostgresError(error);
        }),
    });
  }

  async #acquire(signal?: AbortSignal): Promise<PoolClient> {
    if (this.#closed)
      throw new PostgresLifecycleError("postgres_lifecycle_closed");
    if (signal?.aborted === true) throw abortError();
    const pending = this.#pool.connect();
    let abortListener: (() => void) | undefined;
    let shutdownListener: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        reject(abortError());
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    const shuttingDown = new Promise<never>((_resolve, reject) => {
      shutdownListener = () => {
        reject(new PostgresLifecycleError("postgres_lifecycle_closed"));
      };
      this.#shutdown.signal.addEventListener("abort", shutdownListener, {
        once: true,
      });
    });
    try {
      const client = await withTimeout(
        Promise.race([pending, aborted, shuttingDown]),
        this.#config.connectionTimeoutMs,
        new PostgresLifecycleError("postgres_lifecycle_pool_timeout"),
      );
      this.#active.add(client);
      return client;
    } catch (error) {
      void pending
        .then((client) => {
          client.release(true);
        })
        .catch(() => undefined);
      throw error;
    } finally {
      if (abortListener !== undefined)
        signal?.removeEventListener("abort", abortListener);
      if (shutdownListener !== undefined)
        this.#shutdown.signal.removeEventListener("abort", shutdownListener);
    }
  }

  #release(client: PoolClient, destroy = false): void {
    if (!this.#active.delete(client) || this.#destroyed.has(client)) return;
    if (destroy) this.#destroyed.add(client);
    try {
      client.release(destroy);
    } catch {
      // A connection error can make pg remove the checked-out client first.
    }
  }

  async #query<Row extends Record<string, unknown>>(
    client: PoolClient,
    text: string,
    values: readonly unknown[] = [],
    signal?: AbortSignal,
  ): Promise<PostgresQueryResult<Row>> {
    if (this.#closed) {
      this.#release(client, true);
      throw new PostgresLifecycleError("postgres_lifecycle_closed");
    }
    if (signal?.aborted === true) {
      this.#release(client, true);
      throw abortError();
    }
    let abortListener: (() => void) | undefined;
    let shutdownListener: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => {
        this.#release(client, true);
        reject(abortError());
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    const shuttingDown = new Promise<never>((_resolve, reject) => {
      shutdownListener = () => {
        this.#release(client, true);
        reject(new PostgresLifecycleError("postgres_lifecycle_closed"));
      };
      this.#shutdown.signal.addEventListener("abort", shutdownListener, {
        once: true,
      });
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        this.#release(client, true);
        reject(new PostgresLifecycleError("postgres_lifecycle_query_timeout"));
      }, this.#config.queryTimeoutMs);
      timeout.unref();
    });
    try {
      const result = await Promise.race([
        client.query<Row>(text, [...values]),
        aborted,
        shuttingDown,
        timedOut,
      ]);
      return Object.freeze({ rowCount: result.rowCount, rows: result.rows });
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      if (abortListener !== undefined)
        signal?.removeEventListener("abort", abortListener);
      if (shutdownListener !== undefined)
        this.#shutdown.signal.removeEventListener("abort", shutdownListener);
    }
  }

  async #fault(
    client: PoolClient,
    boundary: PostgresLifecycleFaultBoundary,
    injector?: PostgresLifecycleFaultInjector,
  ): Promise<void> {
    if (injector === undefined) return;
    let shutdownListener: (() => void) | undefined;
    const shuttingDown = new Promise<never>((_resolve, reject) => {
      shutdownListener = () => {
        reject(new PostgresLifecycleError("postgres_lifecycle_closed"));
      };
      this.#shutdown.signal.addEventListener("abort", shutdownListener, {
        once: true,
      });
    });
    const processId = backendProcessId(client);
    const action = await Promise.race([
      injector.hit({
        backendProcessId: processId,
        boundary,
      }),
      shuttingDown,
    ]).finally(() => {
      if (shutdownListener !== undefined)
        this.#shutdown.signal.removeEventListener("abort", shutdownListener);
    });
    if (action !== "terminate_connection") return;
    await this.#pool.query("SELECT pg_terminate_backend($1)", [processId]);
    throw new ForcedConnectionTermination();
  }

  public async transaction<T>(
    work: (client: PostgresQueryClient) => Promise<T>,
    options: TransactionOptions,
  ): Promise<T> {
    const client = await this.#acquire(options.signal);
    const isolationLevel = options.isolationLevel ?? "SERIALIZABLE";
    let began = false;
    let commitAttempted = false;
    let commitAcknowledged = false;
    try {
      const queryClient: PostgresQueryClient = Object.freeze({
        backendProcessId: backendProcessId(client),
        query: <Row extends Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
          signal?: AbortSignal,
        ) => this.#query<Row>(client, text, values, signal ?? options.signal),
      });
      await this.#fault(client, "before_begin", options.faults);
      await this.#query(
        client,
        `BEGIN ISOLATION LEVEL ${isolationLevel}`,
        [],
        options.signal,
      );
      began = true;
      options.trace?.append(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      await this.#query(
        client,
        `SET LOCAL lock_timeout = '${String(this.#config.lockTimeoutMs)}ms'`,
        [],
        options.signal,
      );
      await this.#query(
        client,
        `SET LOCAL statement_timeout = '${String(this.#config.statementTimeoutMs)}ms'`,
        [],
        options.signal,
      );
      await this.#query(
        client,
        "SET LOCAL synchronous_commit = 'on'",
        [],
        options.signal,
      );
      await this.#fault(client, "after_begin", options.faults);
      const result = await work(queryClient);
      await this.#fault(client, "after_writes", options.faults);
      await this.#fault(client, "before_commit", options.faults);
      commitAttempted = true;
      await this.#query(client, "COMMIT", [], options.signal);
      commitAcknowledged = true;
      options.trace?.append("COMMIT");
      await this.#fault(client, "after_commit", options.faults);
      return result;
    } catch (error) {
      if (began && !commitAttempted) {
        try {
          await this.#query(client, "ROLLBACK");
          options.trace?.append("ROLLBACK");
        } catch {
          this.#release(client, true);
        }
      }
      if (isConnectionFailure(error)) this.#release(client, true);
      throw new TransactionFailure(error, commitAttempted, commitAcknowledged);
    } finally {
      this.#release(client);
    }
  }

  public async read<T>(
    work: (client: PostgresQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let client: PoolClient;
    try {
      client = await this.#acquire(signal);
    } catch (error) {
      throw sanitizePostgresError(error);
    }
    try {
      return await work(
        Object.freeze({
          backendProcessId: backendProcessId(client),
          query: <Row extends Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
            querySignal?: AbortSignal,
          ) => this.#query<Row>(client, text, values, querySignal ?? signal),
        }),
      );
    } catch (error) {
      throw sanitizePostgresError(error);
    } finally {
      this.#release(client);
    }
  }

  public async reconcile<T>(
    work: (client: PostgresQueryClient) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.#config.connectionTimeoutMs + this.#config.queryTimeoutMs);
    timeout.unref();
    try {
      return await this.read(work, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  public close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#shutdown.abort();
    this.#closePromise = (async () => {
      for (const client of [...this.#active]) this.#release(client, true);
      await withTimeout(
        this.#pool.end(),
        this.#config.shutdownTimeoutMs,
        new PostgresLifecycleError("postgres_lifecycle_shutdown_timeout"),
      ).catch((error: unknown) => {
        throw sanitizePostgresError(error);
      });
    })();
    return this.#closePromise;
  }
}
