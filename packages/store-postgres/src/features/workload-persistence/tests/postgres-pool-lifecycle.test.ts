import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type PostgresDriverPool,
  PostgresPoolRuntime,
} from "../postgres-pool.js";

function syntheticDatabaseCredential(): string {
  return Array.from({ length: 32 }, (_, index) =>
    String.fromCharCode(97 + ((index * 7) % 26)),
  ).join("");
}

function config() {
  return {
    applicationName: "workload-funnel-pool-test",
    connectionTimeoutMs: 50,
    database: "wf_pool_test",
    host: "127.0.0.1",
    idleTimeoutMs: 100,
    lockTimeoutMs: 50,
    maxConnections: 1,
    password: syntheticDatabaseCredential(),
    port: 5432,
    profile: "disposable-test" as const,
    queryTimeoutMs: 500,
    schema: "wf_pool_test",
    schemaOwner: "wf_pool_owner",
    shutdownTimeoutMs: 500,
    statementTimeoutMs: 100,
    tls: false as const,
    user: "wf_pool_owner",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function client(query: PoolClient["query"] = vi.fn()) {
  const release = vi.fn();
  const value = {
    processID: 42,
    query,
    release,
  } as unknown as PoolClient;
  return { release, value };
}

function pool(connect: PostgresDriverPool["connect"]) {
  const end = vi.fn(() => Promise.resolve());
  const value = {
    connect,
    end,
    on: vi.fn(function () {
      return value;
    }),
    query: vi.fn(),
  } as unknown as PostgresDriverPool;
  return { end, value };
}

describe("Postgres pool bounded lifecycle", () => {
  it("aborts a queued acquisition and destroys a connection that arrives late", async () => {
    const connection = deferred<PoolClient>();
    const driver = pool(() => connection.promise);
    const runtime = new PostgresPoolRuntime(config(), driver.value);
    const controller = new AbortController();
    const read = runtime.read(
      () => Promise.resolve("unreachable"),
      controller.signal,
    );

    controller.abort();
    await expect(read).rejects.toMatchObject({
      code: "postgres_lifecycle_aborted",
    });
    const late = client();
    connection.resolve(late.value);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.release).toHaveBeenCalledWith(true);
    await runtime.close();
    expect(driver.end).toHaveBeenCalledOnce();
  });

  it("times out pool exhaustion and cleans up its eventual connection", async () => {
    const connection = deferred<PoolClient>();
    const driver = pool(() => connection.promise);
    const runtime = new PostgresPoolRuntime(config(), driver.value);

    await expect(
      runtime.read(() => Promise.resolve("unreachable")),
    ).rejects.toMatchObject({ code: "postgres_lifecycle_pool_timeout" });
    const late = client();
    connection.resolve(late.value);
    await Promise.resolve();
    await Promise.resolve();
    expect(late.release).toHaveBeenCalledWith(true);
    await runtime.close();
  });

  it("aborts checked-out queries and closes the driver exactly once", async () => {
    const queryStarted = deferred<true>();
    const pending = new Promise<never>(() => undefined);
    const checkedOut = client(
      vi.fn((text: string) => {
        if (text === "SELECT synthetic_block") {
          queryStarted.resolve(true);
          return pending;
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      }) as unknown as PoolClient["query"],
    );
    const driver = pool(() => Promise.resolve(checkedOut.value));
    const runtime = new PostgresPoolRuntime(config(), driver.value);
    const read = runtime.read((queryClient) =>
      queryClient.query("SELECT synthetic_block"),
    );
    await queryStarted.promise;

    const firstClose = runtime.close();
    await expect(read).rejects.toMatchObject({
      code: "postgres_lifecycle_closed",
    });
    await firstClose;
    await runtime.close();
    expect(checkedOut.release).toHaveBeenCalledWith(true);
    expect(driver.end).toHaveBeenCalledOnce();
  });
});
