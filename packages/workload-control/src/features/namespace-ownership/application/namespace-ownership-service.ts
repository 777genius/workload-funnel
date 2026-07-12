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
    mutationFence: MutationFence,
  ): NamespaceOwnership;
  abort(
    namespaceId: string,
    operationId: string,
    mutationFence: MutationFence,
  ): NamespaceOwnership;
  advance(
    namespaceId: string,
    operationId: string,
    targetRelease: string,
    mutationFence: MutationFence,
  ): NamespaceOwnership;
  acknowledge(
    namespaceId: string,
    operationId: string,
    acknowledgement: AuthorityInstallAcknowledgement,
    mutationFence: MutationFence,
  ): NamespaceOwnership;
  complete(
    namespaceId: string,
    operationId: string,
    mutationFence: MutationFence,
  ): NamespaceOwnership;
  get(namespaceId: string): NamespaceOwnership | undefined;
}

export function createNamespaceOwnershipService(
  store: NamespaceOwnershipStore,
): NamespaceOwnershipService {
  function assertNamespaceMutationFence(
    ownership: NamespaceOwnership,
    mutationFence: MutationFence,
  ): void {
    validateMutationFence(mutationFence);
    if (
      mutationFence.namespaceId !== ownership.namespaceId ||
      mutationFence.namespaceWriterEpoch !== ownership.writerEpoch
    ) {
      throw new Error("namespace_mutation_fence_mismatch");
    }
  }
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
      mutationFence: MutationFence,
    ) {
      const before = current(namespaceId);
      assertNamespaceMutationFence(before, mutationFence);
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
    abort(
      namespaceId: string,
      operationId: string,
      mutationFence: MutationFence,
    ) {
      const before = current(namespaceId);
      assertNamespaceMutationFence(before, mutationFence);
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
    advance(
      namespaceId: string,
      operationId: string,
      targetRelease: string,
      mutationFence: MutationFence,
    ) {
      const before = current(namespaceId);
      assertNamespaceMutationFence(before, mutationFence);
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
      mutationFence: MutationFence,
    ) {
      const before = current(namespaceId);
      assertNamespaceMutationFence(before, mutationFence);
      if (
        acknowledgement.tupleFingerprint !==
        fingerprintMutationFence(mutationFence)
      ) {
        throw new Error("namespace_authority_fence_fingerprint_mismatch");
      }
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
    complete(
      namespaceId: string,
      operationId: string,
      mutationFence: MutationFence,
    ) {
      const before = current(namespaceId);
      assertNamespaceMutationFence(before, mutationFence);
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
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
