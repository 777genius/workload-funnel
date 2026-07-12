import type { OwnershipTransferCoordinator } from "../../domain/transfer-coordinator.js";

export interface CrashResumableOwnershipTransferStore {
  create(
    coordinator: OwnershipTransferCoordinator,
  ): OwnershipTransferCoordinator;
  get(operationId: string): OwnershipTransferCoordinator | undefined;
  save(
    expectedVersion: number,
    coordinator: OwnershipTransferCoordinator,
  ): OwnershipTransferCoordinator;
  discoverIncomplete(
    cursor: string | undefined,
    limit: number,
  ): readonly OwnershipTransferCoordinator[];
}
