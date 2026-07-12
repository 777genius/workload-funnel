import {
  canonicalParticipantIds,
  InvalidParticipantSetError,
  type CanonicalBundleId,
  type CanonicalBundleReceipt,
  type CanonicalParticipantId,
  type CanonicalTransactionParticipant,
  type CanonicalTransactionTrace,
} from "../domain/canonical-bundle.js";
import {
  canonicalBundleMatrix,
  participantSupportedModes,
} from "../domain/canonical-bundle-matrix.js";

export interface CanonicalTransactionRequest {
  readonly bundleId: CanonicalBundleId;
  readonly operationId: string;
  readonly ranks: readonly number[];
  readonly activeParticipants: readonly CanonicalParticipantId[];
}

export interface CanonicalTransactionResult<T> {
  readonly value: T;
  readonly trace: CanonicalTransactionTrace;
}

export interface CanonicalTransaction {
  execute<T>(
    request: CanonicalTransactionRequest,
    work: () => T,
  ): CanonicalTransactionResult<T>;
}

export type CanonicalParticipantRegistry = Readonly<
  Record<CanonicalParticipantId, CanonicalTransactionParticipant>
>;

export interface CanonicalCoordinator {
  execute<T>(
    bundleId: CanonicalBundleId,
    operationId: string,
    work: () => T,
  ): T;
  receipt(operationId: string): CanonicalBundleReceipt | undefined;
  readonly participantIds: readonly CanonicalParticipantId[];
}

function assertExactModes(participant: CanonicalTransactionParticipant): void {
  const expected = participantSupportedModes[participant.id];
  if (
    [...participant.supportedModes].sort().join("|") !==
    [...expected].sort().join("|")
  ) {
    throw new InvalidParticipantSetError(
      `${participant.id} does not expose its exact canonical mode set`,
    );
  }
  const expectedFinalizer = participant.id === "allocation-leasing";
  if (participant.finalizesRank160 !== expectedFinalizer) {
    throw new InvalidParticipantSetError(
      `${participant.id} has an invalid rank-160 finalizer declaration`,
    );
  }
  const expectedStoreCounts: Readonly<Record<CanonicalParticipantId, number>> =
    Object.freeze({
      "allocation-leasing": 2,
      "audit-history": 1,
      "capacity-management": 1,
      "control-event-delivery": 3,
      "result-management": 4,
      "tenant-admission": 2,
      "workload-lifecycle": 1,
    });
  if (participant.ownerStoreCount !== expectedStoreCounts[participant.id]) {
    throw new InvalidParticipantSetError(
      `${participant.id} does not bind its exact owner-store set`,
    );
  }
}

function validateRegistry(
  participants: CanonicalParticipantRegistry,
): CanonicalParticipantRegistry {
  const keys = Object.keys(participants).sort();
  const expectedKeys = [...canonicalParticipantIds].sort();
  if (keys.join("|") !== expectedKeys.join("|")) {
    throw new InvalidParticipantSetError(
      "Exactly seven keyed canonical participants are required",
    );
  }
  for (const id of canonicalParticipantIds) {
    const participant = participants[id];
    if (participant.id !== id) {
      throw new InvalidParticipantSetError(
        `Canonical participant key ${id} is bound to ${participant.id}`,
      );
    }
    assertExactModes(participant);
  }
  for (const definition of Object.values(canonicalBundleMatrix)) {
    for (const [id, mode] of Object.entries(definition.modes)) {
      const participant = participants[id as CanonicalParticipantId];
      if (!participant.supportedModes.includes(mode)) {
        throw new InvalidParticipantSetError(
          `${id} cannot execute ${definition.bundleId} mode ${mode}`,
        );
      }
    }
  }
  return Object.freeze({ ...participants });
}

export interface CreateCanonicalCoordinatorInput {
  readonly canonicalTransaction: CanonicalTransaction;
  readonly participants: CanonicalParticipantRegistry;
}

export function createProvider(
  input: CreateCanonicalCoordinatorInput,
): CanonicalCoordinator {
  const participants = validateRegistry(input.participants);
  const receipts = new Map<string, CanonicalBundleReceipt>();
  const coordinator: CanonicalCoordinator = {
    execute(bundleId, operationId, work) {
      const definition = canonicalBundleMatrix[bundleId];
      const activeParticipants = canonicalParticipantIds.filter(
        (id) => definition.modes[id] !== undefined,
      );
      const result = input.canonicalTransaction.execute(
        {
          activeParticipants,
          bundleId,
          operationId,
          ranks: definition.ranks,
        },
        work,
      );
      receipts.set(
        operationId,
        Object.freeze({
          activeParticipants: Object.freeze([...activeParticipants]),
          bundleId,
          operationId,
          ranks: definition.ranks,
          trace: result.trace,
        }),
      );
      return result.value;
    },
    participantIds: Object.freeze(
      canonicalParticipantIds.filter((id) => participants[id].id === id),
    ),
    receipt: (operationId) => receipts.get(operationId),
  };
  return Object.freeze(coordinator);
}

export const createCanonicalCoordinator = createProvider;
