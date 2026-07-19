import { describe, expect, it } from "vitest";

import {
  migratePostgresLifecycleSchema,
  type PostgresMigrationClient,
  type PostgresMigrationExecutor,
  type PostgresMigrationQueryResult,
  verifyPostgresLifecycleSchema,
} from "../index.js";

interface MigrationRecord extends Record<string, unknown> {
  readonly checksum: string;
  readonly version: number;
}

class TransactionalMigrationFixture implements PostgresMigrationExecutor {
  public readonly installed: MigrationRecord[];
  public failOn: string | undefined;

  public constructor(installed: MigrationRecord[] = []) {
    this.installed = installed;
  }

  public async transaction<T>(
    work: (client: PostgresMigrationClient) => Promise<T>,
  ): Promise<T> {
    const snapshot = [...this.installed];
    const client: PostgresMigrationClient = {
      query: <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<PostgresMigrationQueryResult<Row>> => {
        if (this.failOn !== undefined && text.includes(this.failOn))
          return Promise.reject(
            new Error("synthetic_migration_statement_failure"),
          );
        if (text.includes("SELECT version, checksum"))
          return Promise.resolve({
            rowCount: this.installed.length,
            rows: this.installed as unknown as readonly Row[],
          });
        if (text.includes("INSERT INTO wf_migration_test.schema_migration")) {
          this.installed.push({
            checksum: values[1] as string,
            version: values[0] as number,
          });
          return Promise.resolve({ rowCount: 1, rows: [] });
        }
        if (text.includes("FROM pg_namespace"))
          return Promise.resolve({
            rowCount: 1,
            rows: [
              {
                current_role: "wf_migration_owner",
                schema_owned: true,
                sequence_count: 3,
                sequences_owned: true,
                table_count: 20,
                tables_owned: true,
              } as unknown as Row,
            ],
          });
        return Promise.resolve({ rowCount: null, rows: [] });
      },
    };
    try {
      return await work(client);
    } catch (error) {
      this.installed.splice(0, this.installed.length, ...snapshot);
      throw error;
    }
  }
}

const migrationInput = (executor: PostgresMigrationExecutor) => ({
  executor,
  owner: "wf_migration_owner",
  schema: "wf_migration_test",
});

describe("Postgres production schema migration", () => {
  it("verifies exact preinstalled state without creating missing migrations", async () => {
    const fixture = new TransactionalMigrationFixture();

    await expect(
      verifyPostgresLifecycleSchema(migrationInput(fixture)),
    ).rejects.toMatchObject({ code: "postgres_migration_state_invalid" });
    expect(fixture.installed).toEqual([]);

    await migratePostgresLifecycleSchema(migrationInput(fixture));
    await expect(
      verifyPostgresLifecycleSchema(migrationInput(fixture)),
    ).resolves.toMatchObject({ currentVersion: 2 });
  });

  it("rolls back an interrupted v2 migration and resumes to the exact version", async () => {
    const fixture = new TransactionalMigrationFixture();
    fixture.failOn = "CREATE TABLE wf_migration_test.control_capacity";

    await expect(
      migratePostgresLifecycleSchema(migrationInput(fixture)),
    ).rejects.toMatchObject({ code: "postgres_migration_failed" });
    expect(fixture.installed).toEqual([]);

    fixture.failOn = undefined;
    await expect(
      migratePostgresLifecycleSchema(migrationInput(fixture)),
    ).resolves.toMatchObject({
      currentVersion: 2,
      schema: "wf_migration_test",
    });
    expect(fixture.installed.map((row) => row.version)).toEqual([1, 2]);
    expect(
      fixture.installed.every((row) => /^[a-f0-9]{64}$/u.test(row.checksum)),
    ).toBe(true);
  });

  it("rejects changed or out-of-order migration history before DDL", async () => {
    const fixture = new TransactionalMigrationFixture([
      { checksum: "0".repeat(64), version: 1 },
    ]);
    await expect(
      migratePostgresLifecycleSchema(migrationInput(fixture)),
    ).rejects.toMatchObject({ code: "postgres_migration_corrupt" });
    expect(fixture.installed).toEqual([
      { checksum: "0".repeat(64), version: 1 },
    ]);
  });

  it("leaves a non-empty legacy schema at version 1 for explicit import", async () => {
    const seed = new TransactionalMigrationFixture();
    await migratePostgresLifecycleSchema(migrationInput(seed));
    const versionOne = seed.installed[0];
    if (versionOne === undefined)
      throw new Error("test_migration_seed_missing");
    const fixture = new TransactionalMigrationFixture([versionOne]);
    fixture.failOn = "workload_funnel_v2_requires_explicit_legacy_import";

    await expect(
      migratePostgresLifecycleSchema(migrationInput(fixture)),
    ).rejects.toMatchObject({ code: "postgres_migration_failed" });
    expect(fixture.installed).toEqual([versionOne]);
  });
});
