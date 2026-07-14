import { DatabaseSync } from "node:sqlite";

import type {
  ArtifactAuthorityWatermark,
  ArtifactMutationAuthorityReceipt,
  ArtifactMutationAuthorityStore,
  ArtifactMutationAuthorityTransaction,
} from "@workload-funnel/workload-control/result-management";

export interface OpenSqliteArtifactMutationAuthorityStore {
  readonly store: ArtifactMutationAuthorityStore;
  close(): void;
}

interface PayloadRow {
  readonly payload: string;
}

function parse(row: PayloadRow | undefined): unknown {
  return row === undefined ? undefined : (JSON.parse(row.payload) as unknown);
}

function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS artifact_authority_scope (
      effect_scope_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_authority_operation (
      operation_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_authority_watermark (
      storage_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS artifact_authority_sequence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      value INTEGER NOT NULL CHECK (value >= 0)
    ) STRICT;
    INSERT INTO artifact_authority_sequence (singleton, value)
      VALUES (1, 0) ON CONFLICT(singleton) DO NOTHING;
  `);
  const integrity = database.prepare("PRAGMA integrity_check").get() as
    | Readonly<{ integrity_check: string }>
    | undefined;
  if (integrity?.integrity_check !== "ok")
    throw new Error("artifact_authority_store_corrupt");
}

export function createSqliteArtifactMutationAuthorityStore(
  database: DatabaseSync,
): ArtifactMutationAuthorityStore {
  migrate(database);
  return Object.freeze({
    capabilities: Object.freeze({
      crashSafe: true,
      recovered: true,
      transactional: true,
    }),
    transaction<T>(
      callback: (transaction: ArtifactMutationAuthorityTransaction) => T,
    ): T {
      database.exec("BEGIN IMMEDIATE");
      const transaction: ArtifactMutationAuthorityTransaction = {
        getInstalledScope(effectScopeKey) {
          return parse(
            database
              .prepare(
                "SELECT payload FROM artifact_authority_scope WHERE effect_scope_key = ?",
              )
              .get(effectScopeKey) as PayloadRow | undefined,
          ) as ArtifactMutationAuthorityReceipt | undefined;
        },
        getInstallOperation(operationId) {
          return parse(
            database
              .prepare(
                "SELECT payload FROM artifact_authority_operation WHERE operation_id = ?",
              )
              .get(operationId) as PayloadRow | undefined,
          ) as ArtifactMutationAuthorityReceipt | undefined;
        },
        getWatermark(storageKey) {
          return parse(
            database
              .prepare(
                "SELECT payload FROM artifact_authority_watermark WHERE storage_key = ?",
              )
              .get(storageKey) as PayloadRow | undefined,
          ) as ArtifactAuthorityWatermark | undefined;
        },
        nextSequence() {
          const row = database
            .prepare(
              "UPDATE artifact_authority_sequence SET value = value + 1 WHERE singleton = 1 RETURNING value",
            )
            .get() as Readonly<{ value: number }>;
          return row.value;
        },
        putInstalledScope(receipt: ArtifactMutationAuthorityReceipt) {
          database
            .prepare(
              "INSERT INTO artifact_authority_scope (effect_scope_key, payload) VALUES (?, ?) ON CONFLICT(effect_scope_key) DO UPDATE SET payload = excluded.payload",
            )
            .run(receipt.effectScopeKey, JSON.stringify(receipt));
        },
        putInstallOperation(receipt: ArtifactMutationAuthorityReceipt) {
          database
            .prepare(
              "INSERT INTO artifact_authority_operation (operation_id, payload) VALUES (?, ?)",
            )
            .run(receipt.operationId, JSON.stringify(receipt));
        },
        putWatermark(
          storageKey: string,
          watermark: ArtifactAuthorityWatermark,
        ) {
          database
            .prepare(
              "INSERT INTO artifact_authority_watermark (storage_key, payload) VALUES (?, ?) ON CONFLICT(storage_key) DO UPDATE SET payload = excluded.payload",
            )
            .run(storageKey, JSON.stringify(watermark));
        },
      };
      try {
        const result = callback(transaction);
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

export function openSqliteArtifactMutationAuthorityStore(
  path: string,
): OpenSqliteArtifactMutationAuthorityStore {
  const database = new DatabaseSync(path);
  return Object.freeze({
    close: () => {
      database.close();
    },
    store: createSqliteArtifactMutationAuthorityStore(database),
  });
}
