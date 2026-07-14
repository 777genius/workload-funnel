import type { ServiceIdentityAuthorityStore } from "../application/contracts/service-identity-authority-store.js";
import {
  ServiceIdentityAuthorityError,
  type NodeMessageReplayCursor,
  type ServiceIdentityOperationReceipt,
  type ServiceIdentityRecord,
} from "../domain/service-identity.js";

export interface PostgresServiceIdentityAuthorityDriver {
  readonly capabilities: Readonly<{
    backend: string;
    crashSafe: boolean;
    multiWriter: boolean;
    serializableTransactions: boolean;
  }>;
  migrate(statements: readonly string[]): void;
  transaction<T>(callback: () => T): T;
  getIdentity(identityId: string): ServiceIdentityRecord | undefined;
  insertIdentity(
    identity: ServiceIdentityRecord,
  ): "inserted" | "identity_conflict" | "node_conflict" | "credential_conflict";
  compareAndSetIdentity(
    expectedVersion: number,
    identity: ServiceIdentityRecord,
  ): "updated" | "version_conflict" | "credential_conflict";
  getOperation(
    operationId: string,
  ): ServiceIdentityOperationReceipt | undefined;
  insertOperation(receipt: ServiceIdentityOperationReceipt): boolean;
  getCursor(credentialId: string): NodeMessageReplayCursor | undefined;
  compareAndSetCursor(
    expectedVersion: number,
    cursor: NodeMessageReplayCursor,
  ): boolean;
}

const migrations = Object.freeze([
  "CREATE TABLE IF NOT EXISTS service_identity (identity_id text PRIMARY KEY, node_id text UNIQUE, version bigint NOT NULL CHECK (version > 0), payload jsonb NOT NULL)",
  "CREATE TABLE IF NOT EXISTS service_identity_credential (credential_id text PRIMARY KEY, identity_id text NOT NULL REFERENCES service_identity(identity_id) ON DELETE CASCADE, certificate_fingerprint text NOT NULL UNIQUE, certificate_serial text NOT NULL UNIQUE, generation bigint NOT NULL CHECK (generation > 0), UNIQUE(identity_id, generation))",
  "CREATE TABLE IF NOT EXISTS service_identity_operation (operation_id text PRIMARY KEY, operation_fingerprint text NOT NULL, payload jsonb NOT NULL)",
  "CREATE TABLE IF NOT EXISTS node_message_cursor (credential_id text PRIMARY KEY, version bigint NOT NULL CHECK (version > 0), payload jsonb NOT NULL)",
]);

export function createPostgresServiceIdentityAuthorityStore(
  driver: PostgresServiceIdentityAuthorityDriver,
): ServiceIdentityAuthorityStore {
  if (
    driver.capabilities.backend !== "postgres" ||
    !driver.capabilities.crashSafe ||
    !driver.capabilities.multiWriter ||
    !driver.capabilities.serializableTransactions
  )
    throw new ServiceIdentityAuthorityError("identity_authority_incapable");
  driver.migrate(migrations);
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
      return driver.transaction(() => {
        const result = driver.compareAndSetIdentity(expectedVersion, identity);
        if (result === "version_conflict")
          throw new ServiceIdentityAuthorityError("identity_version_conflict");
        if (result === "credential_conflict")
          throw new ServiceIdentityAuthorityError("credential_identity_reused");
        if (!driver.insertOperation(operation))
          throw new ServiceIdentityAuthorityError(
            "identity_operation_replay_conflict",
          );
        return identity;
      });
    },
    create(identity, operation) {
      return driver.transaction(() => {
        const result = driver.insertIdentity(identity);
        if (result === "identity_conflict")
          throw new ServiceIdentityAuthorityError("identity_already_enrolled");
        if (result === "node_conflict")
          throw new ServiceIdentityAuthorityError(
            "node_identity_already_bound",
          );
        if (result === "credential_conflict")
          throw new ServiceIdentityAuthorityError("credential_identity_reused");
        if (!driver.insertOperation(operation))
          throw new ServiceIdentityAuthorityError(
            "identity_operation_replay_conflict",
          );
        return identity;
      });
    },
    get: (identityId) => driver.getIdentity(identityId),
    getNodeMessageCursor: (credentialId) => driver.getCursor(credentialId),
    getOperation: (operationId) => driver.getOperation(operationId),
    authorizeNodeMessage(expectedCursorVersion, cursor) {
      if (
        cursor.version !== expectedCursorVersion + 1 ||
        !driver.compareAndSetCursor(expectedCursorVersion, cursor)
      )
        throw new ServiceIdentityAuthorityError("node_message_cursor_conflict");
      return cursor;
    },
  };
  return Object.freeze(store);
}
