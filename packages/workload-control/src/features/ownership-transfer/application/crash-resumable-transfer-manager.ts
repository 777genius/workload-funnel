import type {
  AuthorityInstallAcknowledgement,
  NamespaceOwnershipService,
} from "@workload-funnel/workload-control/namespace-ownership";
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  closeOperationGates,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";

import type { CrashResumableOwnershipTransferStore } from "./contracts/ownership-transfer-coordinator-store.js";
import {
  advanceOwnershipTransferCoordinator,
  createOwnershipTransferCoordinator,
  nextOwnershipTransferStep,
  type OwnershipTransferCoordinator,
} from "../domain/transfer-coordinator.js";

const ownershipTransferGates = Object.freeze([
  "acceptance",
  "admission_reservation",
  "dispatch_submit",
  "process_start",
  "automatic_retry",
  "result_finalize",
  "result_archive",
  "result_delete",
] as const);

export interface OwnershipTransferEnvironment {
  getGateSet(namespaceId: string): OperationGateSet;
  saveGateSet(gates: OperationGateSet): void;
  drainOldEffects(coordinator: OwnershipTransferCoordinator): string;
  fenceOldAuthorities(coordinator: OwnershipTransferCoordinator): string;
  installAuthority(
    coordinator: OwnershipTransferCoordinator,
    authorityId: string,
    targetEpoch: number,
    mutationFence: MutationFence,
  ): AuthorityInstallAcknowledgement;
  disableOldCredentials(coordinator: OwnershipTransferCoordinator): string;
  reconcileAtNewEpoch(coordinator: OwnershipTransferCoordinator): string;
  reopenApprovedGates(
    coordinator: OwnershipTransferCoordinator,
    current: OperationGateSet,
  ): OperationGateSet;
}

export interface CrashResumableOwnershipTransferManager {
  begin(
    input: Readonly<{
      namespaceId: string;
      operationId: string;
      targetWriterId: string;
      targetWriterRelease: string;
      authorityIds: readonly string[];
      mutationFence: MutationFence;
    }>,
  ): OwnershipTransferCoordinator;
  resume(operationId: string): OwnershipTransferCoordinator;
  abortBeforeEpochCas(
    operationId: string,
    evidenceDigest: string,
  ): OwnershipTransferCoordinator;
  discoverIncomplete(
    cursor: string | undefined,
    limit: number,
  ): readonly OwnershipTransferCoordinator[];
}

export function createCrashResumableOwnershipTransferManager(
  ownership: NamespaceOwnershipService,
  coordinators: CrashResumableOwnershipTransferStore,
  environment: OwnershipTransferEnvironment,
): CrashResumableOwnershipTransferManager {
  function current(operationId: string): OwnershipTransferCoordinator {
    const value = coordinators.get(operationId);
    if (value === undefined) throw new Error("ownership_transfer_not_found");
    return value;
  }
  function persist(
    before: OwnershipTransferCoordinator,
    after: OwnershipTransferCoordinator,
  ): OwnershipTransferCoordinator {
    return before === after ? before : coordinators.save(before.version, after);
  }
  return Object.freeze({
    begin(
      input: Readonly<{
        namespaceId: string;
        operationId: string;
        targetWriterId: string;
        targetWriterRelease: string;
        authorityIds: readonly string[];
        mutationFence: MutationFence;
      }>,
    ) {
      validateMutationFence(input.mutationFence);
      const aggregate = ownership.get(input.namespaceId);
      if (aggregate === undefined)
        throw new Error("namespace_ownership_not_found");
      const pending = ownership.begin(
        input.namespaceId,
        input.operationId,
        input.targetWriterId,
        input.authorityIds,
        input.mutationFence,
      );
      return coordinators.create(
        createOwnershipTransferCoordinator({
          authorityIds: input.authorityIds,
          gateRevision: environment.getGateSet(input.namespaceId).revision,
          namespaceId: input.namespaceId,
          operationId: input.operationId,
          ownershipVersion: pending.version,
          mutationFence: input.mutationFence,
          targetWriterId: input.targetWriterId,
          targetWriterRelease: input.targetWriterRelease,
        }),
      );
    },
    resume(operationId: string) {
      const before = current(operationId);
      const next = nextOwnershipTransferStep(before);
      if (next === undefined) return before;
      let evidenceDigest: string;
      let ownershipVersion = before.ownershipVersion;
      let gateRevision = before.gateRevision;
      let mutationFence = before.mutationFence;
      switch (next) {
        case "gates_closed": {
          const gates = environment.getGateSet(before.namespaceId);
          const alreadyClosed = ownershipTransferGates.every(
            (gate) => !gates.open.has(gate),
          );
          const closed = alreadyClosed
            ? gates
            : closeOperationGates({
                authorizationGate: "process_start",
                current: gates,
                expectedRevision: gates.revision,
                gates: ownershipTransferGates,
                mutationFence: before.mutationFence,
              });
          if (!alreadyClosed) environment.saveGateSet(closed);
          gateRevision = closed.revision;
          mutationFence = Object.freeze({
            ...before.mutationFence,
            operationGateRevision: closed.revision,
          });
          validateMutationFence(mutationFence);
          evidenceDigest = `gate-revision:${String(closed.revision)}`;
          break;
        }
        case "old_effects_drained":
          evidenceDigest = environment.drainOldEffects(before);
          break;
        case "old_authorities_fenced":
          evidenceDigest = environment.fenceOldAuthorities(before);
          break;
        case "epoch_advanced": {
          const advanced = ownership.advance(
            before.namespaceId,
            before.operationId,
            before.targetWriterRelease,
            before.mutationFence,
          );
          ownershipVersion = advanced.version;
          mutationFence = Object.freeze({
            ...before.mutationFence,
            namespaceWriterEpoch: advanced.writerEpoch,
          });
          validateMutationFence(mutationFence);
          evidenceDigest = `writer-epoch:${String(advanced.writerEpoch)}`;
          break;
        }
        case "new_authorities_installed": {
          let aggregate = ownership.get(before.namespaceId);
          if (aggregate === undefined)
            throw new Error("namespace_ownership_not_found");
          const digests: string[] = [];
          for (const authorityId of before.authorityIds) {
            const acknowledgement = environment.installAuthority(
              before,
              authorityId,
              aggregate.writerEpoch,
              before.mutationFence,
            );
            aggregate = ownership.acknowledge(
              before.namespaceId,
              before.operationId,
              acknowledgement,
              before.mutationFence,
            );
            digests.push(acknowledgement.tupleFingerprint);
          }
          ownershipVersion = aggregate.version;
          evidenceDigest = `authority-installs:${digests.sort().join(",")}`;
          break;
        }
        case "old_credentials_disabled":
          evidenceDigest = environment.disableOldCredentials(before);
          break;
        case "ownership_completed": {
          const completed = ownership.complete(
            before.namespaceId,
            before.operationId,
            before.mutationFence,
          );
          ownershipVersion = completed.version;
          evidenceDigest = environment.reconcileAtNewEpoch(before);
          break;
        }
        case "gates_reopened": {
          const currentGates = environment.getGateSet(before.namespaceId);
          const alreadyReopened = ownershipTransferGates.every((gate) =>
            currentGates.open.has(gate),
          );
          const reopened = alreadyReopened
            ? currentGates
            : environment.reopenApprovedGates(before, currentGates);
          if (!alreadyReopened) environment.saveGateSet(reopened);
          gateRevision = reopened.revision;
          mutationFence = Object.freeze({
            ...before.mutationFence,
            operationGateRevision: reopened.revision,
          });
          validateMutationFence(mutationFence);
          evidenceDigest = `gate-revision:${String(reopened.revision)}`;
          break;
        }
        case "aborted":
        case "begun":
          throw new Error("invalid_ownership_transfer_resume_step");
      }
      return persist(
        before,
        advanceOwnershipTransferCoordinator(
          before,
          next,
          evidenceDigest,
          ownershipVersion,
          gateRevision,
          mutationFence,
        ),
      );
    },
    abortBeforeEpochCas(operationId: string, evidenceDigest: string) {
      const before = current(operationId);
      const aggregate = ownership.abort(
        before.namespaceId,
        before.operationId,
        before.mutationFence,
      );
      return persist(
        before,
        advanceOwnershipTransferCoordinator(
          before,
          "aborted",
          evidenceDigest,
          aggregate.version,
          before.gateRevision,
          before.mutationFence,
        ),
      );
    },
    discoverIncomplete: (cursor: string | undefined, limit: number) =>
      coordinators.discoverIncomplete(cursor, limit),
  });
}
