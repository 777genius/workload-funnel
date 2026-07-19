import { describe, expect, it } from "vitest";

import {
  createAsyncPostgresNamespaceOwnershipStore,
  type DurableNamespaceOwnership,
  type PostgresNamespaceExecutor,
  type PostgresNamespaceQueryClient,
  type PostgresNamespaceQueryResult,
} from "../async-postgres-namespace-store.js";

interface Row extends Record<string, unknown> {
  namespace_id: string;
  payload: Readonly<Record<string, unknown>>;
  version: string;
  writer_epoch: string;
  writer_id: string;
}

class DurableNamespaceFixture implements PostgresNamespaceExecutor {
  public readonly rows = new Map<string, Row>();

  public read<T>(
    work: (client: PostgresNamespaceQueryClient) => Promise<T>,
  ): Promise<T> {
    return work(this.client());
  }

  public transaction<T>(
    work: (client: PostgresNamespaceQueryClient) => Promise<T>,
  ): Promise<T> {
    return work(this.client());
  }

  private client(): PostgresNamespaceQueryClient {
    return {
      query: <Result extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresNamespaceQueryResult<Result>> => {
        const statement = text.trimStart();
        if (statement.startsWith("INSERT INTO")) {
          const namespaceId = values[0] as string;
          if (!this.rows.has(namespaceId))
            this.rows.set(namespaceId, {
              namespace_id: namespaceId,
              payload: JSON.parse(values[4] as string) as Readonly<
                Record<string, unknown>
              >,
              version: String(values[3]),
              writer_epoch: String(values[2]),
              writer_id: values[1] as string,
            });
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        if (statement.startsWith("UPDATE")) {
          const namespaceId = values[0] as string;
          const current = this.rows.get(namespaceId);
          const currentMatches =
            current?.version === String(values[1]) &&
            current.writer_epoch === String(values[6]);
          if (!currentMatches)
            return Promise.resolve({ rowCount: 0, rows: [] });
          const row: Row = {
            namespace_id: namespaceId,
            payload: JSON.parse(values[5] as string) as Readonly<
              Record<string, unknown>
            >,
            version: String(values[2]),
            writer_epoch: String(values[4]),
            writer_id: values[3] as string,
          };
          this.rows.set(namespaceId, row);
          return Promise.resolve({
            rowCount: 1,
            rows: [row as unknown as Result],
          });
        }
        if (statement.startsWith("SELECT 1")) {
          const row = this.rows.get(values[0] as string);
          const matches =
            row !== undefined &&
            row.writer_id === values[1] &&
            row.writer_epoch === String(values[2]);
          return Promise.resolve({ rowCount: matches ? 1 : 0, rows: [] });
        }
        if (statement.includes("LIMIT 0"))
          return Promise.resolve({ rowCount: 0, rows: [] });
        const row = this.rows.get(values[0] as string);
        return Promise.resolve({
          rowCount: row === undefined ? 0 : 1,
          rows: row === undefined ? [] : [row as unknown as Result],
        });
      },
    };
  }
}

function ownership(
  namespaceId: string,
  writerId: string,
  writerEpoch: number,
  version: number,
): DurableNamespaceOwnership {
  return Object.freeze({
    namespaceId,
    payload: Object.freeze({ installedFence: writerEpoch }),
    version,
    writerEpoch,
    writerId,
  });
}

describe("async Postgres namespace ownership", () => {
  it("survives adapter restart and rejects a stale concurrent writer", async () => {
    const database = new DurableNamespaceFixture();
    const firstProcess = createAsyncPostgresNamespaceOwnershipStore(
      database,
      "wf_namespace_test",
    );
    await firstProcess.create(ownership("namespace-1", "writer-a", 1, 1));

    const restartedProcess = createAsyncPostgresNamespaceOwnershipStore(
      database,
      "wf_namespace_test",
    );
    await expect(restartedProcess.get("namespace-1")).resolves.toEqual(
      ownership("namespace-1", "writer-a", 1, 1),
    );
    await expect(
      restartedProcess.compareAndSet(
        "namespace-1",
        1,
        1,
        ownership("namespace-1", "writer-b", 1, 2),
      ),
    ).rejects.toThrow("postgres_namespace_version_conflict");
    await expect(
      restartedProcess.compareAndSet(
        "namespace-1",
        1,
        1,
        ownership("namespace-1", "writer-b", 2, 2),
      ),
    ).resolves.toEqual(ownership("namespace-1", "writer-b", 2, 2));
    await expect(
      firstProcess.compareAndSet(
        "namespace-1",
        1,
        1,
        ownership("namespace-1", "writer-stale", 2, 2),
      ),
    ).rejects.toThrow("postgres_namespace_version_conflict");
    await expect(
      restartedProcess.assertWriter("namespace-1", "writer-b", 2),
    ).resolves.toBeUndefined();
  });

  it("keeps delimiter-bearing namespace identities distinct", async () => {
    const database = new DurableNamespaceFixture();
    const store = createAsyncPostgresNamespaceOwnershipStore(
      database,
      "wf_namespace_test",
    );
    await store.create(ownership("tenant:a/namespace:b", "writer-a", 1, 1));
    await store.create(ownership("tenant:a:namespace/b", "writer-b", 1, 1));

    expect(database.rows).toHaveLength(2);
    await expect(store.get("tenant:a/namespace:b")).resolves.toMatchObject({
      writerId: "writer-a",
    });
    await expect(store.get("tenant:a:namespace/b")).resolves.toMatchObject({
      writerId: "writer-b",
    });
  });
});
