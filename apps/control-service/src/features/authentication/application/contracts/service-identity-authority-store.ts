import type {
  NodeMessageReplayCursor,
  ServiceIdentityOperationReceipt,
  ServiceIdentityRecord,
} from "../../domain/service-identity.js";

export interface ServiceIdentityAuthorityStoreCapabilities {
  readonly authenticatedWrites: boolean;
  readonly compareAndSet: boolean;
  readonly durable: boolean;
  readonly multiWriter: boolean;
}

export interface ServiceIdentityAuthorityStore {
  readonly capabilities: ServiceIdentityAuthorityStoreCapabilities;
  get(identityId: string): ServiceIdentityRecord | undefined;
  getOperation(
    operationId: string,
  ): ServiceIdentityOperationReceipt | undefined;
  create(
    identity: ServiceIdentityRecord,
    receipt: ServiceIdentityOperationReceipt,
  ): ServiceIdentityRecord;
  compareAndSet(
    expectedVersion: number,
    identity: ServiceIdentityRecord,
    receipt: ServiceIdentityOperationReceipt,
  ): ServiceIdentityRecord;
  authorizeNodeMessage(
    expectedCursorVersion: number,
    cursor: NodeMessageReplayCursor,
  ): NodeMessageReplayCursor;
  getNodeMessageCursor(
    credentialId: string,
  ): NodeMessageReplayCursor | undefined;
}
