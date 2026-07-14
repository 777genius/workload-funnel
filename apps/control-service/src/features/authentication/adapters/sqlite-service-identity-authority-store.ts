import { DatabaseSync } from "node:sqlite";

import type { ServiceIdentityAuthorityStore } from "../application/contracts/service-identity-authority-store.js";
import {
  ServiceIdentityAuthorityError,
  type NodeMessageReplayCursor,
  type ServiceIdentityOperationReceipt,
  type ServiceIdentityRecord,
} from "../domain/service-identity.js";

export interface OpenSqliteServiceIdentityAuthorityStore {
  readonly store: ServiceIdentityAuthorityStore;
  close(): void;
}

interface PayloadRow {
  readonly payload: string;
}

function transaction<T>(database: DatabaseSync, callback: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS service_identity (
      identity_id TEXT PRIMARY KEY,
      node_id TEXT UNIQUE,
      version INTEGER NOT NULL CHECK (version > 0),
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS service_identity_credential (
      credential_id TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES service_identity(identity_id) ON DELETE CASCADE,
      certificate_fingerprint TEXT NOT NULL UNIQUE,
      certificate_serial TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL CHECK (generation > 0),
      UNIQUE (identity_id, generation)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS service_identity_operation (
      operation_id TEXT PRIMARY KEY,
      operation_fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS node_message_cursor (
      credential_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0),
      payload TEXT NOT NULL
    ) STRICT;
  `);
}

function parse(row: PayloadRow | undefined): unknown {
  return row === undefined ? undefined : (JSON.parse(row.payload) as unknown);
}

function readIdentity(
  database: DatabaseSync,
  identityId: string,
): ServiceIdentityRecord | undefined {
  return parse(
    database
      .prepare("SELECT payload FROM service_identity WHERE identity_id = ?")
      .get(identityId) as PayloadRow | undefined,
  ) as ServiceIdentityRecord | undefined;
}

function insertOperation(
  database: DatabaseSync,
  receipt: ServiceIdentityOperationReceipt,
): void {
  const inserted = database
    .prepare(
      "INSERT INTO service_identity_operation (operation_id, operation_fingerprint, payload) VALUES (?, ?, ?) ON CONFLICT(operation_id) DO NOTHING",
    )
    .run(
      receipt.operationId,
      receipt.operationFingerprint,
      JSON.stringify(receipt),
    ).changes;
  if (inserted !== 1)
    throw new ServiceIdentityAuthorityError(
      "identity_operation_replay_conflict",
    );
}

function insertCredentials(
  database: DatabaseSync,
  identity: ServiceIdentityRecord,
): void {
  const statement = database.prepare(
    "INSERT INTO service_identity_credential (credential_id, identity_id, certificate_fingerprint, certificate_serial, generation) VALUES (?, ?, ?, ?, ?)",
  );
  try {
    for (const credential of identity.credentials)
      statement.run(
        credential.credentialId,
        identity.identityId,
        credential.certificateFingerprint,
        credential.certificateSerial,
        credential.generation,
      );
  } catch {
    throw new ServiceIdentityAuthorityError("credential_identity_reused");
  }
}

export function createSqliteServiceIdentityAuthorityStore(
  database: DatabaseSync,
): ServiceIdentityAuthorityStore {
  migrate(database);
  const store: ServiceIdentityAuthorityStore = {
    capabilities: Object.freeze({
      authenticatedWrites: true,
      compareAndSet: true,
      durable: true,
      multiWriter: true,
    }),
    compareAndSet(expectedVersion, identity, operation) {
      if (identity.version !== expectedVersion + 1)
        throw new ServiceIdentityAuthorityError("identity_version_conflict");
      return transaction(database, () => {
        const changed = database
          .prepare(
            "UPDATE service_identity SET node_id = ?, version = ?, payload = ? WHERE identity_id = ? AND version = ?",
          )
          .run(
            identity.nodeId ?? null,
            identity.version,
            JSON.stringify(identity),
            identity.identityId,
            expectedVersion,
          ).changes;
        if (changed !== 1)
          throw new ServiceIdentityAuthorityError("identity_version_conflict");
        database
          .prepare(
            "DELETE FROM service_identity_credential WHERE identity_id = ?",
          )
          .run(identity.identityId);
        insertCredentials(database, identity);
        insertOperation(database, operation);
        return identity;
      });
    },
    create(identity, operation) {
      return transaction(database, () => {
        try {
          const inserted = database
            .prepare(
              "INSERT INTO service_identity (identity_id, node_id, version, payload) VALUES (?, ?, ?, ?) ON CONFLICT(identity_id) DO NOTHING",
            )
            .run(
              identity.identityId,
              identity.nodeId ?? null,
              identity.version,
              JSON.stringify(identity),
            ).changes;
          if (inserted !== 1) {
            const prior = readIdentity(database, identity.identityId);
            throw new ServiceIdentityAuthorityError(
              prior?.nodeId === identity.nodeId
                ? "identity_already_enrolled"
                : "node_identity_already_bound",
            );
          }
        } catch (error) {
          if (error instanceof ServiceIdentityAuthorityError) throw error;
          throw new ServiceIdentityAuthorityError(
            "node_identity_already_bound",
          );
        }
        insertCredentials(database, identity);
        insertOperation(database, operation);
        return identity;
      });
    },
    get: (identityId) => readIdentity(database, identityId),
    getNodeMessageCursor(credentialId) {
      return parse(
        database
          .prepare(
            "SELECT payload FROM node_message_cursor WHERE credential_id = ?",
          )
          .get(credentialId) as PayloadRow | undefined,
      ) as NodeMessageReplayCursor | undefined;
    },
    getOperation(operationId) {
      return parse(
        database
          .prepare(
            "SELECT payload FROM service_identity_operation WHERE operation_id = ?",
          )
          .get(operationId) as PayloadRow | undefined,
      ) as ServiceIdentityOperationReceipt | undefined;
    },
    authorizeNodeMessage(expectedCursorVersion, cursor) {
      if (cursor.version !== expectedCursorVersion + 1)
        throw new ServiceIdentityAuthorityError("node_message_cursor_conflict");
      const changed =
        expectedCursorVersion === 0
          ? database
              .prepare(
                "INSERT INTO node_message_cursor (credential_id, version, payload) VALUES (?, ?, ?) ON CONFLICT(credential_id) DO NOTHING",
              )
              .run(cursor.credentialId, cursor.version, JSON.stringify(cursor))
              .changes
          : database
              .prepare(
                "UPDATE node_message_cursor SET version = ?, payload = ? WHERE credential_id = ? AND version = ?",
              )
              .run(
                cursor.version,
                JSON.stringify(cursor),
                cursor.credentialId,
                expectedCursorVersion,
              ).changes;
      if (changed !== 1)
        throw new ServiceIdentityAuthorityError("node_message_cursor_conflict");
      return cursor;
    },
  };
  return Object.freeze(store);
}

export function openSqliteServiceIdentityAuthorityStore(
  path: string,
): OpenSqliteServiceIdentityAuthorityStore {
  const database = new DatabaseSync(path);
  return Object.freeze({
    close: () => {
      database.close();
    },
    store: createSqliteServiceIdentityAuthorityStore(database),
  });
}
