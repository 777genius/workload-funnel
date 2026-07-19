import { createHash } from "node:crypto";

import {
  lifecycleSchemaStatements,
  lifecycleTableNames,
} from "./lifecycle-schema.js";
import {
  controlPlaneSchemaStatements,
  controlPlaneTableNames,
} from "./control-plane-schema.js";
import type { PostgresMigrationExecutor } from "./migration-executor.js";

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

interface MigrationRow extends Record<string, unknown> {
  readonly checksum: string;
  readonly version: number;
}

interface OwnershipRow extends Record<string, unknown> {
  readonly current_role: string;
  readonly schema_owned: boolean;
  readonly sequence_count: number;
  readonly sequences_owned: boolean;
  readonly table_count: number;
  readonly tables_owned: boolean;
}

export class PostgresMigrationError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "PostgresMigrationError";
  }
}

function assertIdentifier(value: string, code: string): void {
  if (!identifier.test(value)) throw new PostgresMigrationError(code);
}

function checksum(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join("\n;\n")).digest("hex");
}

function migrationPlan(schema: string): readonly Readonly<{
  checksum: string;
  statements: readonly string[];
  version: number;
}>[] {
  return Object.freeze(
    [
      lifecycleSchemaStatements(schema),
      controlPlaneSchemaStatements(schema),
    ].map((statements, index) =>
      Object.freeze({
        checksum: checksum(statements),
        statements,
        version: index + 1,
      }),
    ),
  );
}

export interface PostgresMigrationReceipt {
  readonly checksums: readonly string[];
  readonly currentVersion: number;
  readonly schema: string;
}

export async function migratePostgresLifecycleSchema(input: {
  readonly executor: PostgresMigrationExecutor;
  readonly owner: string;
  readonly schema: string;
}): Promise<PostgresMigrationReceipt> {
  assertIdentifier(input.schema, "postgres_migration_schema_invalid");
  assertIdentifier(input.owner, "postgres_migration_owner_invalid");
  const plan = migrationPlan(input.schema);
  try {
    return await input.executor.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`workload-funnel:lifecycle-migration:${input.schema}`],
      );
      await client.query(
        `CREATE SCHEMA IF NOT EXISTS ${input.schema} AUTHORIZATION CURRENT_USER`,
      );
      await client.query(`CREATE TABLE IF NOT EXISTS ${input.schema}.schema_migration (
        version integer PRIMARY KEY CHECK (version > 0),
        checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
        installed_by text NOT NULL,
        installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      const installed = await client.query<MigrationRow>(
        `SELECT version, checksum FROM ${input.schema}.schema_migration ORDER BY version`,
      );
      if (installed.rows.length > plan.length) {
        throw new PostgresMigrationError("postgres_migration_corrupt");
      }
      for (const [index, row] of installed.rows.entries()) {
        const expected = plan[index];
        if (
          row.version !== expected?.version ||
          row.checksum !== expected.checksum
        )
          throw new PostgresMigrationError("postgres_migration_corrupt");
      }
      for (const migration of plan.slice(installed.rows.length)) {
        for (const statement of migration.statements)
          await client.query(statement);
        await client.query(
          `INSERT INTO ${input.schema}.schema_migration (version, checksum, installed_by)
           VALUES ($1, $2, CURRENT_USER)`,
          [migration.version, migration.checksum],
        );
      }
      const expectedTables = [
        "schema_migration",
        ...lifecycleTableNames,
        ...controlPlaneTableNames,
      ];
      const expectedSequences = [
        "control_delivery_fence_seq",
        "lifecycle_identity_sequence_id_seq",
        "lifecycle_outbox_sequence_id_seq",
      ];
      const ownership = await client.query<OwnershipRow>(
        `SELECT
           CURRENT_USER::text AS current_role,
           n.nspowner = CURRENT_USER::regrole::oid AS schema_owned,
           count(c.oid)::integer AS table_count,
           coalesce(bool_and(c.relowner = CURRENT_USER::regrole::oid), false) AS tables_owned,
           (SELECT count(s.oid)::integer
              FROM pg_class s
             WHERE s.relnamespace = n.oid
               AND s.relkind = 'S'
               AND s.relname = ANY($3::text[])) AS sequence_count,
           (SELECT coalesce(bool_and(s.relowner = CURRENT_USER::regrole::oid), false)
              FROM pg_class s
             WHERE s.relnamespace = n.oid
               AND s.relkind = 'S'
               AND s.relname = ANY($3::text[])) AS sequences_owned
         FROM pg_namespace n
         LEFT JOIN pg_class c
           ON c.relnamespace = n.oid
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($2::text[])
         WHERE n.nspname = $1
         GROUP BY n.oid, n.nspowner`,
        [input.schema, expectedTables, expectedSequences],
      );
      const row = ownership.rows[0];
      if (
        row?.current_role !== input.owner ||
        !row.schema_owned ||
        !row.tables_owned ||
        row.table_count !== expectedTables.length ||
        !row.sequences_owned ||
        row.sequence_count !== expectedSequences.length
      ) {
        throw new PostgresMigrationError(
          "postgres_migration_ownership_invalid",
        );
      }
      return Object.freeze({
        checksums: Object.freeze(plan.map((migration) => migration.checksum)),
        currentVersion: 2 as const,
        schema: input.schema,
      });
    });
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error;
    throw new PostgresMigrationError("postgres_migration_failed");
  }
}

export async function verifyPostgresLifecycleSchema(input: {
  readonly executor: PostgresMigrationExecutor;
  readonly owner: string;
  readonly schema: string;
}): Promise<PostgresMigrationReceipt> {
  assertIdentifier(input.schema, "postgres_migration_schema_invalid");
  assertIdentifier(input.owner, "postgres_migration_owner_invalid");
  const plan = migrationPlan(input.schema);
  try {
    return await input.executor.transaction(async (client) => {
      await client.query("SET TRANSACTION READ ONLY");
      const installed = await client.query<MigrationRow>(
        `SELECT version, checksum FROM ${input.schema}.schema_migration ORDER BY version`,
      );
      if (installed.rows.length !== plan.length)
        throw new PostgresMigrationError("postgres_migration_state_invalid");
      for (const [index, row] of installed.rows.entries()) {
        const expected = plan[index];
        if (
          row.version !== expected?.version ||
          row.checksum !== expected.checksum
        )
          throw new PostgresMigrationError("postgres_migration_corrupt");
      }
      const expectedTables = [
        "schema_migration",
        ...lifecycleTableNames,
        ...controlPlaneTableNames,
      ];
      const expectedSequences = [
        "control_delivery_fence_seq",
        "lifecycle_identity_sequence_id_seq",
        "lifecycle_outbox_sequence_id_seq",
      ];
      const ownership = await client.query<OwnershipRow>(
        `SELECT
           CURRENT_USER::text AS current_role,
           n.nspowner = CURRENT_USER::regrole::oid AS schema_owned,
           count(c.oid)::integer AS table_count,
           coalesce(bool_and(c.relowner = CURRENT_USER::regrole::oid), false) AS tables_owned,
           (SELECT count(s.oid)::integer
              FROM pg_class s
             WHERE s.relnamespace = n.oid
               AND s.relkind = 'S'
               AND s.relname = ANY($3::text[])) AS sequence_count,
           (SELECT coalesce(bool_and(s.relowner = CURRENT_USER::regrole::oid), false)
              FROM pg_class s
             WHERE s.relnamespace = n.oid
               AND s.relkind = 'S'
               AND s.relname = ANY($3::text[])) AS sequences_owned
         FROM pg_namespace n
         LEFT JOIN pg_class c
           ON c.relnamespace = n.oid
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($2::text[])
         WHERE n.nspname = $1
         GROUP BY n.oid, n.nspowner`,
        [input.schema, expectedTables, expectedSequences],
      );
      const row = ownership.rows[0];
      if (
        row?.current_role !== input.owner ||
        !row.schema_owned ||
        !row.tables_owned ||
        row.table_count !== expectedTables.length ||
        !row.sequences_owned ||
        row.sequence_count !== expectedSequences.length
      )
        throw new PostgresMigrationError(
          "postgres_migration_ownership_invalid",
        );
      return Object.freeze({
        checksums: Object.freeze(plan.map((migration) => migration.checksum)),
        currentVersion: 2 as const,
        schema: input.schema,
      });
    });
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error;
    throw new PostgresMigrationError("postgres_migration_state_invalid");
  }
}
