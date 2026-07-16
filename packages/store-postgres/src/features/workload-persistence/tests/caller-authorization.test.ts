import {
  authenticatedCallerScope,
  lifecycleOperationId,
} from "@workload-funnel/workload-control/workload-lifecycle";
import { describe, expect, it } from "vitest";

import { cancelPostgresLifecycle } from "../cancellation.js";
import { LifecycleReads } from "../lifecycle-reads.js";
import type {
  PostgresPoolRuntime,
  PostgresQueryClient,
  PostgresQueryResult,
} from "../postgres-pool.js";

const owner = Object.freeze({
  namespaceId: "namespace",
  principalId: "segment:principal",
  tenantId: "tenant-a",
});
const foreignCallers = Object.freeze([
  Object.freeze({
    namespaceId: "namespace:segment",
    principalId: "principal",
    tenantId: owner.tenantId,
  }),
  Object.freeze({ ...owner, tenantId: "tenant-b" }),
]);

describe("Postgres lifecycle caller authorization", () => {
  it("returns no status or operation disclosure to foreign caller scopes", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const client: PostgresQueryClient = Object.freeze({
      backendProcessId: 1,
      query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> => {
        queries.push(Object.freeze({ text, values }));
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    });
    const pool = {
      async read<T>(
        work: (queryClient: PostgresQueryClient) => Promise<T>,
      ): Promise<T> {
        return work(client);
      },
    } as unknown as PostgresPoolRuntime;
    const reads = new LifecycleReads(pool, "wf_authorization_test");
    const ownerOperationId = lifecycleOperationId(
      "submit",
      authenticatedCallerScope(owner),
      "shared-key",
    );

    for (const caller of foreignCallers) {
      const callerScope = authenticatedCallerScope(caller);
      await expect(reads.getStatus(callerScope, "owner-run")).resolves.toBe(
        undefined,
      );
      await expect(
        reads.getOperation(callerScope, ownerOperationId),
      ).resolves.toBe(undefined);
    }

    expect(queries).toHaveLength(4);
    expect(
      queries.every(
        ({ text, values }) =>
          /^\s*SELECT\b/u.test(text) &&
          foreignCallers.some((caller) =>
            values.includes(authenticatedCallerScope(caller)),
          ),
      ),
    ).toBe(true);
    const statusQueries = queries.filter(({ text }) =>
      text.includes("lifecycle_run r"),
    );
    expect(statusQueries).toHaveLength(2);
    expect(
      statusQueries.every(
        ({ text }) =>
          text.includes("JOIN wf_authorization_test.lifecycle_attempt") &&
          text.includes("JOIN wf_authorization_test.lifecycle_workload") &&
          text.includes("to_jsonb(attempt)"),
      ),
    ).toBe(true);
  });

  it("performs no mutation when foreign callers cancel an owned run", async () => {
    const queries: Readonly<{
      text: string;
      values: readonly unknown[];
    }>[] = [];
    const client: PostgresQueryClient = Object.freeze({
      backendProcessId: 2,
      query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresQueryResult<Row>> => {
        queries.push(Object.freeze({ text, values }));
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    });
    const pool = {
      async transaction<T>(
        work: (queryClient: PostgresQueryClient) => Promise<T>,
      ): Promise<T> {
        return work(client);
      },
    } as unknown as PostgresPoolRuntime;

    for (const caller of foreignCallers) {
      const callerScope = authenticatedCallerScope(caller);
      await expect(
        cancelPostgresLifecycle(
          { pool, schema: "wf_authorization_test" },
          callerScope,
          "owner-run",
          lifecycleOperationId("cancel", callerScope, "shared-key"),
        ),
      ).rejects.toMatchObject({ code: "postgres_lifecycle_not_found" });
    }

    expect(
      queries.some(({ text }) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(text)),
    ).toBe(false);
    expect(
      queries.filter(({ text }) =>
        text.includes("FROM wf_authorization_test.lifecycle_run"),
      ),
    ).toHaveLength(2);
  });
});
