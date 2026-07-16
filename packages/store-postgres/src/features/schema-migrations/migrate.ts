import { createHash } from "node:crypto";

import {
  lifecycleSchemaStatements,
  lifecycleTableNames,
} from "./lifecycle-schema.js";
import type { PostgresMigrationExecutor } from "./migration-executor.js";

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

interface MigrationRow extends Record<string, unknown> {
  readonly checksum: string;
  readonly version: number;
}

interface OwnershipRow extends Record<string, unknown> {
  readonly current_role: string;
  readonly schema_owned: boolean;
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

export async function migratePostgresLifecycleSchema(input: {
  readonly executor: PostgresMigrationExecutor;
  readonly owner: string;
  readonly schema: string;
}): Promise<void> {
  assertIdentifier(input.schema, "postgres_migration_schema_invalid");
  assertIdentifier(input.owner, "postgres_migration_owner_invalid");
  const statements = lifecycleSchemaStatements(input.schema);
  const expectedChecksum = checksum(statements);
  try {
    await input.executor.transaction(async (client) => {
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
      if (
        installed.rows.length > 1 ||
        (installed.rows[0] !== undefined &&
          (installed.rows[0].version !== 1 ||
            installed.rows[0].checksum !== expectedChecksum))
      ) {
        throw new PostgresMigrationError("postgres_migration_corrupt");
      }
      if (installed.rows.length === 0) {
        for (const statement of statements) await client.query(statement);
        await client.query(
          `INSERT INTO ${input.schema}.schema_migration (version, checksum, installed_by)
           VALUES (1, $1, CURRENT_USER)`,
          [expectedChecksum],
        );
      }
      const ownership = await client.query<OwnershipRow>(
        `SELECT
           CURRENT_USER::text AS current_role,
           n.nspowner = CURRENT_USER::regrole::oid AS schema_owned,
           count(c.oid)::integer AS table_count,
           coalesce(bool_and(c.relowner = CURRENT_USER::regrole::oid), false) AS tables_owned
         FROM pg_namespace n
         LEFT JOIN pg_class c
           ON c.relnamespace = n.oid
          AND c.relkind IN ('r', 'p')
          AND c.relname = ANY($2::text[])
         WHERE n.nspname = $1
         GROUP BY n.nspowner`,
        [input.schema, ["schema_migration", ...lifecycleTableNames]],
      );
      const row = ownership.rows[0];
      if (
        row?.current_role !== input.owner ||
        !row.schema_owned ||
        !row.tables_owned ||
        row.table_count !== lifecycleTableNames.length + 1
      ) {
        throw new PostgresMigrationError(
          "postgres_migration_ownership_invalid",
        );
      }
    });
  } catch (error) {
    if (error instanceof PostgresMigrationError) throw error;
    throw new PostgresMigrationError("postgres_migration_failed");
  }
}
