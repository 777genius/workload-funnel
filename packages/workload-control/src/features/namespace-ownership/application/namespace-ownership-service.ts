import type { NamespaceOwnershipStore } from "./contracts/namespace-ownership-store.js";
import {
  abortOwnershipTransfer,
  acknowledgeOwnershipAuthority,
  advanceWriterEpoch,
  beginOwnershipTransfer,
  completeOwnershipTransfer,
  initializeNamespaceOwnership,
  type AuthorityInstallAcknowledgement,
  type NamespaceOwnership,
} from "../domain/namespace-ownership.js";

export interface NamespaceOwnershipService {
  initialize(
    namespaceId: string,
    writerId: string,
    release: string,
  ): NamespaceOwnership;
  begin(
    namespaceId: string,
    operationId: string,
    targetWriterId: string,
    authorities: readonly string[],
  ): NamespaceOwnership;
  abort(namespaceId: string, operationId: string): NamespaceOwnership;
  advance(
    namespaceId: string,
    operationId: string,
    targetRelease: string,
  ): NamespaceOwnership;
  acknowledge(
    namespaceId: string,
    operationId: string,
    acknowledgement: AuthorityInstallAcknowledgement,
  ): NamespaceOwnership;
  complete(namespaceId: string, operationId: string): NamespaceOwnership;
  get(namespaceId: string): NamespaceOwnership | undefined;
}

export function createNamespaceOwnershipService(
  store: NamespaceOwnershipStore,
): NamespaceOwnershipService {
  function current(namespaceId: string): NamespaceOwnership {
    const value = store.get(namespaceId);
    if (value === undefined)
      throw new Error("Namespace ownership does not exist");
    return value;
  }
  function save(
    before: NamespaceOwnership,
    after: NamespaceOwnership,
  ): NamespaceOwnership {
    if (before === after) return before;
    return store.compareAndSet(before.namespaceId, before.version, after);
  }
  return Object.freeze({
    initialize: (namespaceId: string, writerId: string, release: string) =>
      store.create(
        initializeNamespaceOwnership(namespaceId, writerId, release),
      ),
    begin(
      namespaceId: string,
      operationId: string,
      targetWriterId: string,
      authorities: readonly string[],
    ) {
      const before = current(namespaceId);
      return save(
        before,
        beginOwnershipTransfer(before, {
          expectedVersion: before.version,
          operationId,
          requiredAuthorityIds: authorities,
          targetWriterId,
        }),
      );
    },
    abort(namespaceId: string, operationId: string) {
      const before = current(namespaceId);
      if (
        before.transfer?.operationId === operationId &&
        before.transfer.state === "aborted"
      ) {
        return before;
      }
      return save(
        before,
        abortOwnershipTransfer(before, operationId, before.version),
      );
    },
    advance(namespaceId: string, operationId: string, targetRelease: string) {
      const before = current(namespaceId);
      if (
        before.transfer?.operationId === operationId &&
        before.transfer.state === "epoch_advanced"
      ) {
        return before;
      }
      return save(
        before,
        advanceWriterEpoch(before, {
          expectedVersion: before.version,
          operationId,
          targetEpoch: before.writerEpoch + 1,
          targetWriterRelease: targetRelease,
        }),
      );
    },
    acknowledge(
      namespaceId: string,
      operationId: string,
      acknowledgement: AuthorityInstallAcknowledgement,
    ) {
      const before = current(namespaceId);
      return save(
        before,
        acknowledgeOwnershipAuthority(
          before,
          operationId,
          acknowledgement,
          before.version,
        ),
      );
    },
    complete(namespaceId: string, operationId: string) {
      const before = current(namespaceId);
      if (
        before.transfer?.operationId === operationId &&
        before.transfer.state === "completed"
      ) {
        return before;
      }
      return save(
        before,
        completeOwnershipTransfer(before, operationId, before.version),
      );
    },
    get: (namespaceId: string) => store.get(namespaceId),
  });
}
