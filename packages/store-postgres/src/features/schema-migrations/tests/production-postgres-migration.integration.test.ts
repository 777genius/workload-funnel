import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createPostgresLifecycleDatabase } from "../../workload-persistence/index.js";
import { lifecycleSchemaStatements } from "../lifecycle-schema.js";
import {
  migratePostgresLifecycleSchema,
  verifyPostgresLifecycleSchema,
} from "../migrate.js";

const connectionString = process.env["WF_CONTROL_POSTGRES_TEST_URL"];
const describePostgres =
  connectionString === undefined ? describe.skip : describe;
const opened: ReturnType<typeof createPostgresLifecycleDatabase>[] = [];
const schemas = new Set<string>();

function connection() {
  if (connectionString === undefined)
    throw new Error("postgres_integration_url_missing");
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !/^wf_control_test_[a-z0-9_]{1,40}$/u.test(database) ||
    url.hostname.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  )
    throw new Error("postgres_integration_url_unsafe");
  return Object.freeze({
    database,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port,
    user: decodeURIComponent(url.username),
  });
}

function schema(): string {
  const value = `wf_control_migration_${randomUUID().replaceAll("-", "")}`;
  schemas.add(value);
  return value;
}

function database(schemaName: string) {
  const value = connection();
  const result = createPostgresLifecycleDatabase({
    config: {
      applicationName: "workload-funnel-migration-it",
      connectionTimeoutMs: 1_000,
      database: value.database,
      host: value.host,
      idleTimeoutMs: 1_000,
      lockTimeoutMs: 1_000,
      maxConnections: 4,
      password: value.password,
      port: value.port,
      profile: "disposable-test",
      queryTimeoutMs: 5_000,
      schema: schemaName,
      schemaOwner: value.user,
      shutdownTimeoutMs: 2_000,
      statementTimeoutMs: 4_000,
      tls: false,
      user: value.user,
    },
  });
  opened.push(result);
  return result;
}

async function migrate(
  value: ReturnType<typeof createPostgresLifecycleDatabase>,
) {
  return migratePostgresLifecycleSchema({
    executor: value.migrationExecutor,
    owner: value.schemaOwner,
    schema: value.schema,
  });
}

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map((value) => value.close()));
  for (const schemaName of schemas) {
    const cleanup = database(schemaName);
    try {
      await cleanup.queryExecutor.transaction((client) =>
        client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`),
      );
    } finally {
      await cleanup.close();
      opened.splice(opened.indexOf(cleanup), 1);
    }
  }
  schemas.clear();
});

describePostgres("production Postgres migration integration", () => {
  it("rolls back failed DDL and rejects a corrupted migration ledger", async () => {
    const schemaName = schema();
    const store = database(schemaName);
    await expect(
      verifyPostgresLifecycleSchema({
        executor: store.migrationExecutor,
        owner: store.schemaOwner,
        schema: schemaName,
      }),
    ).rejects.toMatchObject({ code: "postgres_migration_state_invalid" });
    await store.queryExecutor.transaction(async (client) => {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(
        `CREATE TABLE ${schemaName}.control_capacity (marker integer)`,
      );
    });

    await expect(migrate(store)).rejects.toMatchObject({
      code: "postgres_migration_failed",
    });
    await expect(
      store.queryExecutor.read(async (client) => {
        const result = await client.query<
          Record<string, unknown> & {
            lifecycle_table: string | null;
            migration_table: string | null;
          }
        >(
          "SELECT to_regclass($1) AS migration_table, to_regclass($2) AS lifecycle_table",
          [
            `${schemaName}.schema_migration`,
            `${schemaName}.lifecycle_workload`,
          ],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({ lifecycle_table: null, migration_table: null });

    await store.queryExecutor.transaction((client) =>
      client.query(`DROP TABLE ${schemaName}.control_capacity`),
    );
    await expect(migrate(store)).resolves.toMatchObject({ currentVersion: 2 });
    await expect(
      verifyPostgresLifecycleSchema({
        executor: store.migrationExecutor,
        owner: store.schemaOwner,
        schema: schemaName,
      }),
    ).resolves.toMatchObject({ currentVersion: 2 });
    await store.queryExecutor.transaction((client) =>
      client.query(
        `UPDATE ${schemaName}.schema_migration SET checksum = $1 WHERE version = 2`,
        ["0".repeat(64)],
      ),
    );
    await expect(migrate(store)).rejects.toMatchObject({
      code: "postgres_migration_corrupt",
    });
    await expect(
      verifyPostgresLifecycleSchema({
        executor: store.migrationExecutor,
        owner: store.schemaOwner,
        schema: schemaName,
      }),
    ).rejects.toMatchObject({ code: "postgres_migration_corrupt" });
  });

  it("leaves a populated version 1 schema unchanged for explicit import", async () => {
    const schemaName = schema();
    const store = database(schemaName);
    const statements = lifecycleSchemaStatements(schemaName);
    const checksum = createHash("sha256")
      .update(statements.join("\n;\n"))
      .digest("hex");
    await store.queryExecutor.transaction(async (client) => {
      await client.query(`CREATE SCHEMA ${schemaName}`);
      await client.query(`CREATE TABLE ${schemaName}.schema_migration (
        version integer PRIMARY KEY CHECK (version > 0),
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        installed_by text NOT NULL,
        installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      for (const statement of statements) await client.query(statement);
      await client.query(
        `INSERT INTO ${schemaName}.schema_migration
           (version, checksum, installed_by) VALUES (1, $1, CURRENT_USER)`,
        [checksum],
      );
      await client.query(
        `INSERT INTO ${schemaName}.lifecycle_identity DEFAULT VALUES`,
      );
    });

    await expect(migrate(store)).rejects.toMatchObject({
      code: "postgres_migration_failed",
    });
    await expect(
      store.queryExecutor.read(async (client) => {
        const result = await client.query<
          Record<string, unknown> & {
            identity_count: number;
            migration_versions: number[];
            v2_table: string | null;
          }
        >(
          `SELECT
             ARRAY(SELECT version FROM ${schemaName}.schema_migration ORDER BY version)
               AS migration_versions,
             (SELECT count(*)::integer FROM ${schemaName}.lifecycle_identity)
               AS identity_count,
             to_regclass($1) AS v2_table`,
          [`${schemaName}.control_capacity`],
        );
        return result.rows[0];
      }),
    ).resolves.toEqual({
      identity_count: 1,
      migration_versions: [1],
      v2_table: null,
    });
  });
});
