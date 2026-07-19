import { describe, expect, it } from "vitest";

import {
  createAsyncPostgresAuditLedgerStore,
  type PostgresAuditExecutor,
  type PostgresAuditQueryClient,
  type PostgresAuditQueryResult,
} from "../async-postgres-audit-store.js";

interface AuditRow extends Record<string, unknown> {
  action: string;
  actor_id: string;
  details: Readonly<Record<string, unknown>>;
  event_id: string;
  hash: string;
  previous_hash: string;
  resource_id: string;
  sequence_id: string;
  tenant_id: string;
}

class DurableAuditFixture implements PostgresAuditExecutor {
  public readonly rows: AuditRow[] = [];

  public read<T>(
    work: (client: PostgresAuditQueryClient) => Promise<T>,
  ): Promise<T> {
    return work(this.client());
  }

  public async transaction<T>(
    work: (client: PostgresAuditQueryClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = [...this.rows];
    try {
      return await work(this.client());
    } catch (error) {
      this.rows.splice(0, this.rows.length, ...snapshot);
      throw error;
    }
  }

  private client(): PostgresAuditQueryClient {
    return {
      query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresAuditQueryResult<Row>> => {
        if (text.includes("pg_advisory_xact_lock"))
          return Promise.resolve({ rowCount: 1, rows: [] });
        if (text.includes("WHERE event_id = $1")) {
          const row = this.rows.find((item) => item.event_id === values[0]);
          return Promise.resolve({
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [row as unknown as Row],
          });
        }
        if (text.includes("ORDER BY sequence_id DESC")) {
          const row = this.rows.at(-1);
          return Promise.resolve({
            rowCount: row === undefined ? 0 : 1,
            rows: row === undefined ? [] : [row as unknown as Row],
          });
        }
        if (text.trimStart().startsWith("INSERT INTO")) {
          const row: AuditRow = {
            sequence_id: String(values[0]),
            event_id: values[1] as string,
            tenant_id: values[2] as string,
            actor_id: values[3] as string,
            action: values[4] as string,
            resource_id: values[5] as string,
            details: JSON.parse(values[6] as string) as Readonly<
              Record<string, unknown>
            >,
            previous_hash: values[7] as string,
            hash: values[8] as string,
          };
          this.rows.push(row);
          return Promise.resolve({
            rowCount: 1,
            rows: [row as unknown as Row],
          });
        }
        if (text.includes("WHERE tenant_id = $1")) {
          const rows = this.rows
            .filter(
              (row) =>
                row.tenant_id === values[0] &&
                Number(row.sequence_id) > Number(values[1]),
            )
            .slice(0, Number(values[2])) as unknown as Row[];
          return Promise.resolve({ rowCount: rows.length, rows });
        }
        return Promise.resolve({ rowCount: 0, rows: [] });
      },
    };
  }
}

describe("async Postgres audit ledger", () => {
  it("preserves a restart-safe hash chain and event replay identity", async () => {
    const database = new DurableAuditFixture();
    const first = createAsyncPostgresAuditLedgerStore(
      database,
      "wf_audit_test",
    );
    const initial = {
      action: "workload.accepted",
      actorId: "principal-1",
      details: Object.freeze({ z: 2, a: 1 }),
      eventId: "event-1",
      resourceId: "workload-1",
      tenantId: "tenant-1",
    };
    const firstRecord = await first.append(initial);
    expect(firstRecord).toMatchObject({
      previousHash: "genesis",
      sequence: 1,
    });

    const restarted = createAsyncPostgresAuditLedgerStore(
      database,
      "wf_audit_test",
    );
    const secondRecord = await restarted.append({
      ...initial,
      eventId: "event-2",
      resourceId: "workload-2",
    });
    expect(secondRecord).toMatchObject({
      previousHash: firstRecord.hash,
      sequence: 2,
    });
    await expect(restarted.append(initial)).resolves.toEqual(firstRecord);
    await expect(
      restarted.append({
        ...initial,
        details: Object.freeze({ a: 9 }),
      }),
    ).rejects.toThrow("audit_event_id_conflict");
    await expect(restarted.page("tenant-1", 0, 10)).resolves.toHaveLength(2);
  });
});
