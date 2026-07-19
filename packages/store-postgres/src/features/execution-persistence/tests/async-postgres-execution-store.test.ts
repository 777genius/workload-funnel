import { describe, expect, it } from "vitest";

import {
  createAsyncPostgresExecutionStore,
  type PostgresExecutionExecutor,
  type PostgresExecutionQueryClient,
  type PostgresExecutionQueryResult,
} from "../async-postgres-execution-store.js";

interface ExecutionRow extends Record<string, unknown> {
  allocation_id: string;
  attempt_id: string;
  execution_generation: string;
  execution_id: string;
  namespace_id: string;
  owner_fence: string;
  owner_id: string;
  payload: Readonly<Record<string, unknown>>;
  state: "starting" | "running" | "unknown" | "terminal";
  version: string;
  writer_epoch: string;
}

class FencedExecutionFixture implements PostgresExecutionExecutor {
  public execution: ExecutionRow = {
    allocation_id: "allocation-1",
    attempt_id: "attempt-1",
    execution_generation: "generation-1",
    execution_id: "execution-1",
    namespace_id: "namespace-1",
    owner_fence: "5",
    owner_id: "owner-a",
    payload: Object.freeze({ processIdentity: "unit-1" }),
    state: "running",
    version: "3",
    writer_epoch: "11",
  };
  public allocation = {
    execution_generation: "generation-1",
    lease_current: true,
    owner_fence: "6",
    owner_id: "owner-b" as string | null,
    state: "active",
  };
  public namespaceWriterEpoch = "11";

  public read<T>(
    work: (client: PostgresExecutionQueryClient) => Promise<T>,
  ): Promise<T> {
    return work(this.client());
  }

  public async transaction<T>(
    work: (client: PostgresExecutionQueryClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = { ...this.execution };
    try {
      return await work(this.client());
    } catch (error) {
      this.execution = snapshot;
      throw error;
    }
  }

  private client(): PostgresExecutionQueryClient {
    return {
      query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresExecutionQueryResult<Row>> => {
        if (
          text.includes("FROM wf_execution_test.control_execution") &&
          text.includes("FOR UPDATE")
        )
          return Promise.resolve({
            rowCount: 1,
            rows: [this.execution as unknown as Row],
          });
        if (text.includes("FROM wf_execution_test.control_allocation"))
          return Promise.resolve({
            rowCount: 1,
            rows: [this.allocation as unknown as Row],
          });
        if (text.includes("FROM wf_execution_test.control_namespace_ownership"))
          return Promise.resolve({
            rowCount: 1,
            rows: [
              { writer_epoch: this.namespaceWriterEpoch } as unknown as Row,
            ],
          });
        if (
          text.includes("UPDATE wf_execution_test.control_execution") &&
          text.includes("owner_id = $2")
        ) {
          if (
            this.execution.version !== String(values[3]) ||
            this.execution.owner_fence !== String(values[4])
          )
            return Promise.resolve({ rowCount: 0, rows: [] });
          this.execution = {
            ...this.execution,
            owner_id: values[1] as string,
            owner_fence: String(values[2]),
            version: String(Number(this.execution.version) + 1),
          };
          return Promise.resolve({
            rowCount: 1,
            rows: [this.execution as unknown as Row],
          });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    };
  }
}

describe("async Postgres execution ownership", () => {
  it("adopts the same generation with a durable fence and rejects stale writers", async () => {
    const database = new FencedExecutionFixture();
    const firstProcess = createAsyncPostgresExecutionStore(
      database,
      "wf_execution_test",
    );
    const adopted = await firstProcess.takeOwnership(
      "execution-1",
      5,
      "owner-b",
      6,
    );
    expect(adopted).toMatchObject({
      executionGeneration: "generation-1",
      ownerFence: 6,
      ownerId: "owner-b",
      version: 4,
    });

    const restartedProcess = createAsyncPostgresExecutionStore(
      database,
      "wf_execution_test",
    );
    await expect(
      restartedProcess.takeOwnership("execution-1", 5, "owner-b", 6),
    ).resolves.toMatchObject({ ownerFence: 6, ownerId: "owner-b" });
    await expect(
      firstProcess.takeOwnership("execution-1", 5, "owner-stale", 6),
    ).rejects.toThrow("postgres_execution_owner_fence_conflict");

    database.allocation = {
      ...database.allocation,
      owner_fence: "7",
      owner_id: "owner-c",
    };
    database.namespaceWriterEpoch = "12";
    await expect(
      restartedProcess.takeOwnership("execution-1", 6, "owner-c", 7),
    ).rejects.toThrow("postgres_execution_stale_writer_epoch");
    expect(database.execution).toMatchObject({
      execution_generation: "generation-1",
      owner_fence: "6",
      owner_id: "owner-b",
    });
  });
});
