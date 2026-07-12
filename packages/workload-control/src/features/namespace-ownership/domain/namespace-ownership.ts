export type OwnershipTransferState =
  | "pending"
  | "epoch_advanced"
  | "completed"
  | "aborted";

export interface AuthorityInstallAcknowledgement {
  readonly authorityId: string;
  readonly targetEpoch: number;
  readonly tupleFingerprint: string;
  readonly registrySequence: number;
}

export interface NamespaceOwnershipTransfer {
  readonly operationId: string;
  readonly previousWriterId: string;
  readonly previousEpoch: number;
  readonly targetWriterId: string;
  readonly requiredAuthorityIds: readonly string[];
  readonly state: OwnershipTransferState;
  readonly acknowledgements: readonly AuthorityInstallAcknowledgement[];
}

export interface NamespaceOwnership {
  readonly namespaceId: string;
  readonly writerId: string;
  readonly writerRelease: string;
  readonly writerEpoch: number;
  readonly transfer?: NamespaceOwnershipTransfer;
  readonly version: number;
}

export class NamespaceOwnershipConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NamespaceOwnershipConflictError";
  }
}

function assertVersion(
  ownership: NamespaceOwnership,
  expectedVersion: number,
): void {
  if (ownership.version !== expectedVersion) {
    throw new NamespaceOwnershipConflictError("stale_namespace_version");
  }
}

export function initializeNamespaceOwnership(
  namespaceId: string,
  writerId: string,
  writerRelease: string,
): NamespaceOwnership {
  return Object.freeze({
    namespaceId,
    writerEpoch: 1,
    writerId,
    writerRelease,
    version: 1,
  });
}

export function beginOwnershipTransfer(
  ownership: NamespaceOwnership,
  input: Readonly<{
    operationId: string;
    targetWriterId: string;
    requiredAuthorityIds: readonly string[];
    expectedVersion: number;
  }>,
): NamespaceOwnership {
  assertVersion(ownership, input.expectedVersion);
  const current = ownership.transfer;
  if (
    current !== undefined &&
    !["completed", "aborted"].includes(current.state)
  ) {
    if (
      current.operationId === input.operationId &&
      current.targetWriterId === input.targetWriterId
    ) {
      return ownership;
    }
    throw new NamespaceOwnershipConflictError("ownership_transfer_active");
  }
  return Object.freeze({
    ...ownership,
    transfer: Object.freeze({
      acknowledgements: Object.freeze([]),
      operationId: input.operationId,
      previousEpoch: ownership.writerEpoch,
      previousWriterId: ownership.writerId,
      requiredAuthorityIds: Object.freeze(
        [...new Set(input.requiredAuthorityIds)].sort(),
      ),
      state: "pending",
      targetWriterId: input.targetWriterId,
    }),
    version: ownership.version + 1,
  });
}

export function abortOwnershipTransfer(
  ownership: NamespaceOwnership,
  operationId: string,
  expectedVersion: number,
): NamespaceOwnership {
  assertVersion(ownership, expectedVersion);
  const transfer = ownership.transfer;
  if (transfer?.operationId === operationId && transfer.state === "aborted") {
    return ownership;
  }
  if (transfer?.operationId !== operationId || transfer.state !== "pending") {
    throw new NamespaceOwnershipConflictError(
      "ownership_transfer_not_abortable",
    );
  }
  if (
    ownership.writerEpoch !== transfer.previousEpoch ||
    ownership.writerId !== transfer.previousWriterId
  ) {
    throw new NamespaceOwnershipConflictError(
      "ownership_epoch_already_advanced",
    );
  }
  return Object.freeze({
    ...ownership,
    transfer: Object.freeze({ ...transfer, state: "aborted" }),
    version: ownership.version + 1,
  });
}

export function advanceWriterEpoch(
  ownership: NamespaceOwnership,
  input: Readonly<{
    operationId: string;
    targetEpoch: number;
    targetWriterRelease: string;
    expectedVersion: number;
  }>,
): NamespaceOwnership {
  assertVersion(ownership, input.expectedVersion);
  const transfer = ownership.transfer;
  if (
    transfer?.operationId === input.operationId &&
    transfer.state === "epoch_advanced" &&
    ownership.writerEpoch === input.targetEpoch &&
    ownership.writerRelease === input.targetWriterRelease
  ) {
    return ownership;
  }
  if (
    transfer?.operationId !== input.operationId ||
    transfer.state !== "pending"
  ) {
    throw new NamespaceOwnershipConflictError("ownership_transfer_not_pending");
  }
  if (
    ownership.writerEpoch !== transfer.previousEpoch ||
    ownership.writerId !== transfer.previousWriterId ||
    input.targetEpoch !== ownership.writerEpoch + 1
  ) {
    throw new NamespaceOwnershipConflictError("writer_epoch_cas_failed");
  }
  return Object.freeze({
    ...ownership,
    transfer: Object.freeze({ ...transfer, state: "epoch_advanced" }),
    writerEpoch: input.targetEpoch,
    writerId: transfer.targetWriterId,
    writerRelease: input.targetWriterRelease,
    version: ownership.version + 1,
  });
}

export function acknowledgeOwnershipAuthority(
  ownership: NamespaceOwnership,
  operationId: string,
  acknowledgement: AuthorityInstallAcknowledgement,
  expectedVersion: number,
): NamespaceOwnership {
  assertVersion(ownership, expectedVersion);
  const transfer = ownership.transfer;
  if (
    transfer?.operationId !== operationId ||
    transfer.state !== "epoch_advanced" ||
    acknowledgement.targetEpoch !== ownership.writerEpoch ||
    !transfer.requiredAuthorityIds.includes(acknowledgement.authorityId)
  ) {
    throw new NamespaceOwnershipConflictError(
      "invalid_authority_acknowledgement",
    );
  }
  const prior = transfer.acknowledgements.find(
    (item) => item.authorityId === acknowledgement.authorityId,
  );
  if (prior !== undefined) {
    if (JSON.stringify(prior) !== JSON.stringify(acknowledgement)) {
      throw new NamespaceOwnershipConflictError(
        "authority_acknowledgement_conflict",
      );
    }
    return ownership;
  }
  return Object.freeze({
    ...ownership,
    transfer: Object.freeze({
      ...transfer,
      acknowledgements: Object.freeze([
        ...transfer.acknowledgements,
        Object.freeze({ ...acknowledgement }),
      ]),
    }),
    version: ownership.version + 1,
  });
}

export function completeOwnershipTransfer(
  ownership: NamespaceOwnership,
  operationId: string,
  expectedVersion: number,
): NamespaceOwnership {
  assertVersion(ownership, expectedVersion);
  const transfer = ownership.transfer;
  if (transfer?.operationId === operationId && transfer.state === "completed") {
    return ownership;
  }
  if (
    transfer?.operationId !== operationId ||
    transfer.state !== "epoch_advanced"
  ) {
    throw new NamespaceOwnershipConflictError(
      "ownership_transfer_not_advanced",
    );
  }
  const acknowledged = new Set(
    transfer.acknowledgements.map((item) => item.authorityId),
  );
  if (transfer.requiredAuthorityIds.some((id) => !acknowledged.has(id))) {
    throw new NamespaceOwnershipConflictError("authority_inventory_incomplete");
  }
  return Object.freeze({
    ...ownership,
    transfer: Object.freeze({ ...transfer, state: "completed" }),
    version: ownership.version + 1,
  });
}
