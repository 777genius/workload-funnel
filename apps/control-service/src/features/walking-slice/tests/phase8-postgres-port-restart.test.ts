import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createPostgresControlFailoverStore,
  type PostgresControlFailoverDriver,
} from "@workload-funnel/store-postgres/ownership-transfer-coordinator-persistence";
import {
  createPostgresNodePersistence,
  type PostgresDurableRow,
  type PostgresPhase8NodeDriver,
} from "@workload-funnel/store-postgres/node-persistence";
import {
  createPostgresReconciliationClaimStore,
  type PostgresReconciliationClaimDriver,
} from "@workload-funnel/store-postgres/reconciliation-claims";
import type { ReconciliationClaim } from "@workload-funnel/workload-control/canonical-transaction-coordination";
import {
  createNodeMaintenanceOperation,
  registerNode,
} from "@workload-funnel/workload-control/node-lifecycle";
import type { ControlServiceFailoverOperation } from "@workload-funnel/workload-control/ownership-transfer";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const capabilities = Object.freeze({
  backend: "postgres" as const,
  crashSafe: true as const,
  multiWriter: true as const,
  serializableTransactions: true as const,
});

interface FixtureRow {
  readonly key: string;
  readonly version: number;
  readonly payload: string;
}

class DurablePostgresPortFixture {
  protected readonly database: DatabaseSync;

  public constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.database.exec("PRAGMA synchronous=FULL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS fixture_row (
        bucket TEXT NOT NULL,
        key TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (bucket, key)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS fixture_sequence (
        bucket TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      ) STRICT;
    `);
  }

  public close(): void {
    this.database.close();
  }

  public migrate(statements: readonly string[]): void {
    if (statements.length < 1) throw new Error("migration_missing");
  }

  public transaction<T>(callback: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  protected getRow(bucket: string, key: string): FixtureRow | undefined {
    return this.database
      .prepare(
        "SELECT key, version, payload FROM fixture_row WHERE bucket = ? AND key = ?",
      )
      .get(bucket, key) as FixtureRow | undefined;
  }

  protected rows(bucket: string): readonly FixtureRow[] {
    return this.database
      .prepare(
        "SELECT key, version, payload FROM fixture_row WHERE bucket = ? ORDER BY key",
      )
      .all(bucket) as unknown as readonly FixtureRow[];
  }

  protected insertRow(bucket: string, row: FixtureRow): boolean {
    return (
      this.database
        .prepare(
          "INSERT INTO fixture_row (bucket, key, version, payload) VALUES (?, ?, ?, ?) ON CONFLICT(bucket, key) DO NOTHING",
        )
        .run(bucket, row.key, row.version, row.payload).changes === 1
    );
  }

  protected setRow(bucket: string, row: FixtureRow): void {
    this.database
      .prepare(
        "INSERT INTO fixture_row (bucket, key, version, payload) VALUES (?, ?, ?, ?) ON CONFLICT(bucket, key) DO UPDATE SET version = excluded.version, payload = excluded.payload",
      )
      .run(bucket, row.key, row.version, row.payload);
  }

  protected compareAndSetRow(
    bucket: string,
    expectedVersion: number,
    row: FixtureRow,
  ): boolean {
    return (
      this.database
        .prepare(
          "UPDATE fixture_row SET version = ?, payload = ? WHERE bucket = ? AND key = ? AND version = ?",
        )
        .run(row.version, row.payload, bucket, row.key, expectedVersion)
        .changes === 1
    );
  }

  protected deleteRow(
    bucket: string,
    key: string,
    predicate: (row: FixtureRow) => boolean,
  ): boolean {
    const row = this.getRow(bucket, key);
    if (row === undefined || !predicate(row)) return false;
    return (
      this.database
        .prepare("DELETE FROM fixture_row WHERE bucket = ? AND key = ?")
        .run(bucket, key).changes === 1
    );
  }

  protected nextSequence(bucket: string): number {
    this.database
      .prepare(
        "INSERT INTO fixture_sequence (bucket, value) VALUES (?, 0) ON CONFLICT(bucket) DO NOTHING",
      )
      .run(bucket);
    return (
      this.database
        .prepare(
          "UPDATE fixture_sequence SET value = value + 1 WHERE bucket = ? RETURNING value",
        )
        .get(bucket) as Readonly<{ value: number }>
    ).value;
  }
}

class NodeDriver
  extends DurablePostgresPortFixture
  implements PostgresPhase8NodeDriver
{
  public readonly capabilities = capabilities;

  public get(
    table: "phase8_node" | "phase8_node_maintenance",
    key: string,
  ): PostgresDurableRow | undefined {
    return this.getRow(table, key);
  }

  public insert(
    table: "phase8_node" | "phase8_node_maintenance",
    row: PostgresDurableRow,
  ): boolean {
    return this.insertRow(table, row);
  }

  public compareAndSet(
    table: "phase8_node" | "phase8_node_maintenance",
    expectedVersion: number,
    row: PostgresDurableRow,
  ): boolean {
    return this.compareAndSetRow(table, expectedVersion, row);
  }

  public list(table: "phase8_node_maintenance"): readonly PostgresDurableRow[] {
    return this.rows(table);
  }
}

class ClaimDriver
  extends DurablePostgresPortFixture
  implements PostgresReconciliationClaimDriver
{
  public readonly capabilities = capabilities;

  public get(operationId: string): ReconciliationClaim | undefined {
    const row = this.getRow("claim", operationId);
    return row === undefined
      ? undefined
      : (JSON.parse(row.payload) as ReconciliationClaim);
  }

  public nextFence(): number {
    return this.nextSequence("claim-fence");
  }

  public upsert(claim: ReconciliationClaim): void {
    this.setRow("claim", {
      key: claim.operationId,
      payload: JSON.stringify(claim),
      version: claim.fence,
    });
  }

  public delete(operationId: string, fence: number, workerId: string): boolean {
    return this.deleteRow("claim", operationId, (row) => {
      const claim = JSON.parse(row.payload) as ReconciliationClaim;
      return claim.fence === fence && claim.workerId === workerId;
    });
  }

  public renew(
    operationId: string,
    fence: number,
    workerId: string,
    leaseUntil: number,
  ): boolean {
    const current = this.get(operationId);
    if (current?.fence !== fence || current.workerId !== workerId) return false;
    this.setRow("claim", {
      key: operationId,
      payload: JSON.stringify({ ...current, leaseUntil }),
      version: fence,
    });
    return true;
  }
}

class FailoverDriver
  extends DurablePostgresPortFixture
  implements PostgresControlFailoverDriver
{
  public readonly capabilities = capabilities;

  public get(operationId: string): ControlServiceFailoverOperation | undefined {
    const row = this.getRow("failover", operationId);
    return row === undefined
      ? undefined
      : (JSON.parse(row.payload) as ControlServiceFailoverOperation);
  }

  public insert(operation: ControlServiceFailoverOperation): boolean {
    return this.insertRow("failover", {
      key: operation.operationId,
      payload: JSON.stringify(operation),
      version: operation.version,
    });
  }

  public compareAndSet(
    operationId: string,
    expectedVersion: number,
    operation: ControlServiceFailoverOperation,
  ): boolean {
    return this.compareAndSetRow("failover", expectedVersion, {
      key: operationId,
      payload: JSON.stringify(operation),
      version: operation.version,
    });
  }

  public listIncomplete(
    limit: number,
  ): readonly ControlServiceFailoverOperation[] {
    return this.rows("failover")
      .map((row) => JSON.parse(row.payload) as ControlServiceFailoverOperation)
      .filter((operation) => operation.phase !== "completed")
      .slice(0, limit);
  }
}

function path(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `wf-phase8-postgres-${name}-`));
  roots.push(root);
  return join(root, "port.sqlite");
}

function failoverOperation(): ControlServiceFailoverOperation {
  return Object.freeze({
    authorityInventory: Object.freeze({
      complete: true,
      durable: true,
      inventoryDigest: "d".repeat(64),
      inventoryId: "inventory-1",
      inventoryRevision: 1,
      issuedAt: 1,
      namespaceId: "namespace-1",
      notAfter: 1000,
      operationId: "failover-1",
      signatureBase64Url: "synthetic-signature",
      signerKeyId: "synthetic-key",
      targetEpoch: 2,
      targets: Object.freeze([]),
    }),
    closeAcknowledgements: Object.freeze([]),
    drainAcknowledgements: Object.freeze([]),
    evidence: Object.freeze({}),
    expectedCurrentEpoch: 1,
    fromWriterId: "writer-a",
    installAcknowledgements: Object.freeze([]),
    namespaceId: "namespace-1",
    operationId: "failover-1",
    phase: "pending",
    targetEpoch: 2,
    targets: Object.freeze([]),
    toWriterId: "writer-b",
    version: 1,
  });
}

describe("Phase 8 durable Postgres port restart contracts", () => {
  it("reopens node and maintenance CAS state without a Map production path", () => {
    const databasePath = path("node");
    let driver = new NodeDriver(databasePath);
    let persistence = createPostgresNodePersistence(driver);
    const snapshot = registerNode({
      bootEpoch: "node-1:boot:1",
      capabilities: ["synthetic_execution"],
      nodeId: "node-1",
      observation: {
        bootEpoch: "node-1:boot:1",
        capacity: { cpuMillis: 1000, memoryMiB: 512 },
        observedAt: 1,
        pressure: {
          cpuPsiSome: 0,
          ioPsiSome: 0,
          memoryPsiSome: 0,
          sensorState: "healthy",
        },
        sourceSequence: 1,
      },
      poolId: "pool-1",
      pressurePolicy: {
        criticalThreshold: 0.9,
        healthyObservationsToRecover: 2,
        highObservationsToPause: 2,
        highThreshold: 0.7,
        softThreshold: 0.4,
      },
    });
    persistence.nodes.create(snapshot);
    persistence.maintenance.create(
      createNodeMaintenanceOperation({
        kind: "drain",
        nodeId: "node-1",
        operationId: "maintenance-1",
        originalBootEpoch: snapshot.bootEpoch,
        reason: "synthetic-restart",
        requestedBy: "operator-1",
      }),
    );
    driver.close();

    driver = new NodeDriver(databasePath);
    persistence = createPostgresNodePersistence(driver);
    expect(persistence.nodes.get("node-1")).toEqual(snapshot);
    expect(
      persistence.maintenance.claim("maintenance-1", "controller-1", 0, 10, 100)
        .claim,
    ).toMatchObject({ claimFence: 1 });
    driver.close();
  });

  it("reopens reconciliation claims and prevents a conflicting live takeover", () => {
    const databasePath = path("claim");
    let driver = new ClaimDriver(databasePath);
    let store = createPostgresReconciliationClaimStore(driver);
    const claimed = store.claim("operation-1", "worker-a", 100, 1, 0);
    driver.close();

    driver = new ClaimDriver(databasePath);
    store = createPostgresReconciliationClaimStore(driver);
    store.assertCurrent(claimed, 2);
    expect(() => store.claim("operation-1", "worker-b", 200, 2, 1)).toThrow(
      "already claimed",
    );
    const takeover = store.claim("operation-1", "worker-b", 300, 101, 1);
    expect(takeover.fence).toBeGreaterThan(claimed.fence);
    driver.close();
  });

  it("reopens failover phase CAS state", () => {
    const databasePath = path("failover");
    let driver = new FailoverDriver(databasePath);
    let store = createPostgresControlFailoverStore(driver);
    const before = store.create(failoverOperation());
    driver.close();

    driver = new FailoverDriver(databasePath);
    store = createPostgresControlFailoverStore(driver);
    expect(store.get(before.operationId)).toEqual(before);
    const next = Object.freeze({
      ...before,
      phase: "scopes_closed" as const,
      version: 2,
    });
    expect(
      store.compareAndSet(
        1,
        next,
        {
          fence: 1,
          leaseUntil: 100,
          operationId: before.operationId,
          workerId: "worker-a",
        },
        2,
      ),
    ).toEqual(next);
    driver.close();
  });
});
