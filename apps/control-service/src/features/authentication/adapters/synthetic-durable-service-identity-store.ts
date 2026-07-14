import type { ServiceIdentityAuthorityStore } from "../application/contracts/service-identity-authority-store.js";
import {
  ServiceIdentityAuthorityError,
  type NodeMessageReplayCursor,
  type ServiceIdentityOperationReceipt,
  type ServiceIdentityRecord,
} from "../domain/service-identity.js";

export interface InMemoryServiceIdentityStoreTestState {
  readonly identities: Map<string, ServiceIdentityRecord>;
  readonly operations: Map<string, ServiceIdentityOperationReceipt>;
  readonly nodeMessageCursors: Map<string, NodeMessageReplayCursor>;
}

export function createInMemoryServiceIdentityStoreTestState(): InMemoryServiceIdentityStoreTestState {
  return {
    identities: new Map(),
    nodeMessageCursors: new Map(),
    operations: new Map(),
  };
}

export function createInMemoryServiceIdentityStoreTestFake(
  state: InMemoryServiceIdentityStoreTestState,
): ServiceIdentityAuthorityStore {
  function assertCredentialUniqueness(identity: ServiceIdentityRecord): void {
    for (const candidate of state.identities.values()) {
      if (candidate.identityId === identity.identityId) continue;
      if (identity.nodeId !== undefined && candidate.nodeId === identity.nodeId)
        throw new ServiceIdentityAuthorityError("node_identity_already_bound");
      for (const credential of identity.credentials)
        if (
          candidate.credentials.some(
            (other) =>
              other.credentialId === credential.credentialId ||
              other.certificateFingerprint ===
                credential.certificateFingerprint ||
              other.certificateSerial === credential.certificateSerial,
          )
        )
          throw new ServiceIdentityAuthorityError("credential_identity_reused");
    }
  }
  function recordOperation(receipt: ServiceIdentityOperationReceipt): void {
    const prior = state.operations.get(receipt.operationId);
    if (
      prior !== undefined &&
      prior.operationFingerprint !== receipt.operationFingerprint
    )
      throw new ServiceIdentityAuthorityError(
        "identity_operation_replay_conflict",
      );
    state.operations.set(receipt.operationId, receipt);
  }
  const store: ServiceIdentityAuthorityStore = {
    capabilities: Object.freeze({
      authenticatedWrites: true,
      compareAndSet: true,
      durable: false,
      multiWriter: false,
    }),
    compareAndSet(expectedVersion, identity, operation) {
      const current = state.identities.get(identity.identityId);
      if (
        current?.version !== expectedVersion ||
        identity.version !== expectedVersion + 1
      )
        throw new ServiceIdentityAuthorityError("identity_version_conflict");
      assertCredentialUniqueness(identity);
      recordOperation(operation);
      state.identities.set(identity.identityId, identity);
      return identity;
    },
    create(identity, operation) {
      const current = state.identities.get(identity.identityId);
      if (current !== undefined)
        throw new ServiceIdentityAuthorityError("identity_already_enrolled");
      assertCredentialUniqueness(identity);
      recordOperation(operation);
      state.identities.set(identity.identityId, identity);
      return identity;
    },
    get: (identityId) => state.identities.get(identityId),
    getNodeMessageCursor: (credentialId) =>
      state.nodeMessageCursors.get(credentialId),
    getOperation: (operationId) => state.operations.get(operationId),
    authorizeNodeMessage(expectedCursorVersion, cursor) {
      const current = state.nodeMessageCursors.get(cursor.credentialId);
      if (
        (current?.version ?? 0) !== expectedCursorVersion ||
        cursor.version !== expectedCursorVersion + 1
      )
        throw new ServiceIdentityAuthorityError("node_message_cursor_conflict");
      state.nodeMessageCursors.set(cursor.credentialId, cursor);
      return cursor;
    },
  };
  return Object.freeze(store);
}
