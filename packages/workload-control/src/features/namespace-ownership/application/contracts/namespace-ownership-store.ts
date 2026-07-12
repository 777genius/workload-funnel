import type { NamespaceOwnership } from "../../domain/namespace-ownership.js";

export interface NamespaceOwnershipStore {
  create(initial: NamespaceOwnership): NamespaceOwnership;
  get(namespaceId: string): NamespaceOwnership | undefined;
  compareAndSet(
    namespaceId: string,
    expectedVersion: number,
    next: NamespaceOwnership,
  ): NamespaceOwnership;
}
