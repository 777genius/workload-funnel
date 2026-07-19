import { describe, expect, it } from "vitest";

import { LifecycleWrites } from "../lifecycle-writes.js";
import type {
  PostgresPoolRuntime,
  PostgresQueryClient,
  PostgresQueryResult,
} from "../postgres-pool.js";

describe("Postgres lifecycle erasure idempotency", () => {
  it("replays only an exact tuple and performs no mismatch mutation", async () => {
    const prior = Object.freeze({
      changed_count: 3,
      pseudonym: "pseudonym",
      subject_principal_id: "subject",
      tenant_id: "tenant",
    });
    let mutationQueries = 0;
    const client: PostgresQueryClient = Object.freeze({
      backendProcessId: 4,
      query: <Row extends Record<string, unknown>>(
        text: string,
      ): Promise<PostgresQueryResult<Row>> => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(text)) mutationQueries += 1;
        return Promise.resolve({
          rowCount: 1,
          rows: text.includes("FROM wf_erasure_test.lifecycle_erasure")
            ? [prior as unknown as Row]
            : [],
        });
      },
    });
    const pool = {
      async transaction<T>(
        work: (queryClient: PostgresQueryClient) => Promise<T>,
      ): Promise<T> {
        return work(client);
      },
    } as unknown as PostgresPoolRuntime;
    const writes = new LifecycleWrites(pool, "wf_erasure_test");
    const exact = Object.freeze({
      operationId: "operation",
      pseudonym: prior.pseudonym,
      subjectPrincipalId: prior.subject_principal_id,
      tenantId: prior.tenant_id,
    });

    await expect(writes.erasePrincipalReferences(exact)).resolves.toBe(3);
    for (const mismatch of [
      { ...exact, pseudonym: "different-pseudonym" },
      { ...exact, subjectPrincipalId: "different-subject" },
      { ...exact, tenantId: "different-tenant" },
    ])
      await expect(
        writes.erasePrincipalReferences(mismatch),
      ).rejects.toMatchObject({
        code: "postgres_lifecycle_idempotency_conflict",
      });

    expect(mutationQueries).toBe(0);
  });
});
