import {
  fingerprintMutationFence,
  validateMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  ReconciliationClaim,
  ReconciliationClaimStore,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

import type { ControlFailoverStore } from "./contracts/control-failover-store.js";
import {
  assertCompleteFenceInstallAcknowledgement,
  createControlServiceFailoverOperation,
  ControlServiceFailoverError,
  type CompleteFenceInstallAcknowledgement,
  type AuthoritativeFinalAuthorityInventoryReceipt,
  type ControlServiceFailoverOperation,
  type FinalAuthorityCloseAcknowledgement,
  type FinalAuthorityDrainAcknowledgement,
  type FinalMutationAuthorityTarget,
} from "../domain/control-service-failover.js";

export interface FinalMutationAuthority {
  readonly authorityId: string;
  close(
    input: Readonly<{
      operationId: string;
      target: FinalMutationAuthorityTarget;
    }>,
  ): FinalAuthorityCloseAcknowledgement;
  drain(
    input: Readonly<{
      operationId: string;
      target: FinalMutationAuthorityTarget;
      close: FinalAuthorityCloseAcknowledgement;
    }>,
  ): FinalAuthorityDrainAcknowledgement;
  install(
    input: Readonly<{
      operationId: string;
      target: FinalMutationAuthorityTarget;
      drain: FinalAuthorityDrainAcknowledgement;
    }>,
  ): CompleteFenceInstallAcknowledgement;
  reopen(
    input: Readonly<{
      operationId: string;
      acknowledgement: CompleteFenceInstallAcknowledgement;
    }>,
  ): string;
}

export interface ControlServiceFailoverEnvironment {
  inventory(
    input: Readonly<{
      operationId: string;
      namespaceId: string;
      targetEpoch: number;
      writerIdentity: string;
    }>,
  ): AuthoritativeFinalAuthorityInventoryReceipt;
  verifyAuthoritativeInventory(
    receipt: AuthoritativeFinalAuthorityInventoryReceipt,
    now: number,
  ): boolean;
  authority(authorityId: string): FinalMutationAuthority;
  advanceCanonicalWriter(
    input: Readonly<{
      operationId: string;
      namespaceId: string;
      fromWriterId: string;
      toWriterId: string;
      expectedCurrentEpoch: number;
      targetEpoch: number;
    }>,
  ): Readonly<{ writerId: string; writerEpoch: number; receiptDigest: string }>;
  disableOldCredentials(
    input: Readonly<{
      operationId: string;
      fromWriterId: string;
      targetEpoch: number;
    }>,
  ): string;
}

export interface ControlServiceFailoverCoordinator {
  begin(
    input: Readonly<{
      operationId: string;
      namespaceId: string;
      fromWriterId: string;
      toWriterId: string;
      expectedCurrentEpoch: number;
      now: number;
    }>,
  ): ControlServiceFailoverOperation;
  claim(
    operationId: string,
    workerId: string,
    expectedClaimFence: number,
    now: number,
    leaseUntil: number,
  ): ReconciliationClaim;
  resume(
    operationId: string,
    claim: ReconciliationClaim,
    now: number,
  ): ControlServiceFailoverOperation;
  discoverIncomplete(limit: number): readonly ControlServiceFailoverOperation[];
}

function evidenceDigest(values: readonly string[]): string {
  return values.slice().sort().join("|");
}

function validateTargetFence(fence: MutationFence): void {
  validateMutationFence(fence);
}

function assertAuthoritativeInventory(
  environment: ControlServiceFailoverEnvironment,
  operation: ControlServiceFailoverOperation,
  now: number,
): void {
  const inventory = operation.authorityInventory;
  if (
    now < inventory.issuedAt ||
    now >= inventory.notAfter ||
    !inventory.complete ||
    !inventory.durable ||
    !environment.verifyAuthoritativeInventory(inventory, now) ||
    JSON.stringify(inventory.targets) !== JSON.stringify(operation.targets)
  )
    throw new ControlServiceFailoverError(
      "failover_authority_inventory_not_authoritative",
    );
}

export function createControlServiceFailoverCoordinator(
  store: ControlFailoverStore,
  claims: ReconciliationClaimStore,
  environment: ControlServiceFailoverEnvironment,
): ControlServiceFailoverCoordinator {
  function operation(operationId: string): ControlServiceFailoverOperation {
    const current = store.get(operationId);
    if (current === undefined)
      throw new ControlServiceFailoverError("control_failover_not_found");
    return current;
  }
  function save(
    current: ControlServiceFailoverOperation,
    next: Omit<ControlServiceFailoverOperation, "version">,
    claim: ReconciliationClaim,
    now: number,
  ): ControlServiceFailoverOperation {
    claims.assertCurrent(claim, now);
    return store.compareAndSet(
      current.version,
      Object.freeze({ ...next, version: current.version + 1 }),
      claim,
      now,
    );
  }
  const coordinator: ControlServiceFailoverCoordinator = {
    begin(input) {
      const prior = store.get(input.operationId);
      if (prior !== undefined) {
        if (
          prior.namespaceId !== input.namespaceId ||
          prior.fromWriterId !== input.fromWriterId ||
          prior.toWriterId !== input.toWriterId ||
          prior.expectedCurrentEpoch !== input.expectedCurrentEpoch
        )
          throw new ControlServiceFailoverError(
            "control_failover_replay_conflict",
          );
        return prior;
      }
      const targetEpoch = input.expectedCurrentEpoch + 1;
      const authorityInventory = environment.inventory({
        namespaceId: input.namespaceId,
        operationId: input.operationId,
        targetEpoch,
        writerIdentity: input.toWriterId,
      });
      const created = createControlServiceFailoverOperation({
        authorityInventory,
        expectedCurrentEpoch: input.expectedCurrentEpoch,
        fromWriterId: input.fromWriterId,
        namespaceId: input.namespaceId,
        operationId: input.operationId,
        targetEpoch,
        toWriterId: input.toWriterId,
      });
      assertAuthoritativeInventory(environment, created, input.now);
      return store.create(created);
    },
    claim: (operationId, workerId, expectedClaimFence, now, leaseUntil) =>
      claims.claim(operationId, workerId, leaseUntil, now, expectedClaimFence),
    resume(operationId, claim, now) {
      const current = operation(operationId);
      claims.assertCurrent(claim, now);
      switch (current.phase) {
        case "pending": {
          assertAuthoritativeInventory(environment, current, now);
          const acknowledgements = current.targets.map((target) => {
            const acknowledgement = environment
              .authority(target.authorityId)
              .close({ operationId, target });
            if (
              acknowledgement.operationId !== operationId ||
              acknowledgement.authorityId !== target.authorityId ||
              acknowledgement.effectScopeKey !==
                target.mutationFence.effectScopeKey ||
              !acknowledgement.closed ||
              !acknowledgement.durable
            )
              throw new ControlServiceFailoverError(
                "failover_close_ack_mismatch",
              );
            return acknowledgement;
          });
          return save(
            current,
            {
              ...current,
              closeAcknowledgements: Object.freeze(acknowledgements),
              evidence: Object.freeze({
                ...current.evidence,
                scopes_closed: evidenceDigest(
                  acknowledgements.map(
                    (acknowledgement) =>
                      `${acknowledgement.authorityId}:${acknowledgement.effectScopeKey}`,
                  ),
                ),
              }),
              phase: "scopes_closed",
            },
            claim,
            now,
          );
        }
        case "scopes_closed": {
          assertAuthoritativeInventory(environment, current, now);
          const acknowledgements = current.targets.map((target) => {
            const close = current.closeAcknowledgements.find(
              (item) =>
                item.authorityId === target.authorityId &&
                item.effectScopeKey === target.mutationFence.effectScopeKey,
            );
            if (close === undefined)
              throw new ControlServiceFailoverError(
                "failover_close_ack_missing",
              );
            const acknowledgement = environment
              .authority(target.authorityId)
              .drain({ close, operationId, target });
            if (
              acknowledgement.operationId !== operationId ||
              acknowledgement.authorityId !== target.authorityId ||
              acknowledgement.effectScopeKey !==
                target.mutationFence.effectScopeKey ||
              acknowledgement.closeOperationId !== close.operationId ||
              !acknowledgement.drained ||
              !acknowledgement.durable
            )
              throw new ControlServiceFailoverError(
                "failover_drain_ack_mismatch",
              );
            return acknowledgement;
          });
          return save(
            current,
            {
              ...current,
              drainAcknowledgements: Object.freeze(acknowledgements),
              evidence: Object.freeze({
                ...current.evidence,
                old_calls_drained: evidenceDigest(
                  acknowledgements.map(
                    (acknowledgement) =>
                      `${acknowledgement.authorityId}:${acknowledgement.effectScopeKey}`,
                  ),
                ),
              }),
              phase: "old_calls_drained",
            },
            claim,
            now,
          );
        }
        case "old_calls_drained": {
          assertAuthoritativeInventory(environment, current, now);
          const advanced = environment.advanceCanonicalWriter({
            expectedCurrentEpoch: current.expectedCurrentEpoch,
            fromWriterId: current.fromWriterId,
            namespaceId: current.namespaceId,
            operationId,
            targetEpoch: current.targetEpoch,
            toWriterId: current.toWriterId,
          });
          if (
            advanced.writerEpoch !== current.targetEpoch ||
            advanced.writerId !== current.toWriterId ||
            !advanced.receiptDigest
          )
            throw new ControlServiceFailoverError(
              "canonical_epoch_advance_mismatch",
            );
          return save(
            current,
            {
              ...current,
              evidence: Object.freeze({
                ...current.evidence,
                epoch_advanced: advanced.receiptDigest,
              }),
              phase: "epoch_advanced",
            },
            claim,
            now,
          );
        }
        case "epoch_advanced": {
          assertAuthoritativeInventory(environment, current, now);
          const acknowledgements = current.targets.map((target) => {
            validateTargetFence(target.mutationFence);
            if (
              target.mutationFence.namespaceWriterEpoch !==
                current.targetEpoch ||
              target.mutationFenceFingerprint !==
                fingerprintMutationFence(target.mutationFence)
            )
              throw new ControlServiceFailoverError(
                "failover_target_epoch_mismatch",
              );
            const drain = current.drainAcknowledgements.find(
              (item) =>
                item.authorityId === target.authorityId &&
                item.effectScopeKey === target.mutationFence.effectScopeKey,
            );
            if (drain === undefined)
              throw new ControlServiceFailoverError(
                "failover_drain_ack_missing",
              );
            const acknowledgement = environment
              .authority(target.authorityId)
              .install({ drain, operationId, target });
            assertCompleteFenceInstallAcknowledgement(
              target,
              acknowledgement,
              operationId,
            );
            return acknowledgement;
          });
          return save(
            current,
            {
              ...current,
              evidence: Object.freeze({
                ...current.evidence,
                authorities_installed: evidenceDigest(
                  acknowledgements.map(
                    (acknowledgement) =>
                      `${acknowledgement.authorityId}:${acknowledgement.mutationFenceFingerprint}`,
                  ),
                ),
              }),
              installAcknowledgements: Object.freeze(acknowledgements),
              phase: "authorities_installed",
            },
            claim,
            now,
          );
        }
        case "authorities_installed": {
          assertAuthoritativeInventory(environment, current, now);
          const disabled = environment.disableOldCredentials({
            fromWriterId: current.fromWriterId,
            operationId,
            targetEpoch: current.targetEpoch,
          });
          if (!disabled)
            throw new ControlServiceFailoverError(
              "old_credentials_not_disabled",
            );
          return save(
            current,
            {
              ...current,
              evidence: Object.freeze({
                ...current.evidence,
                old_credentials_disabled: disabled,
              }),
              phase: "old_credentials_disabled",
            },
            claim,
            now,
          );
        }
        case "old_credentials_disabled": {
          assertAuthoritativeInventory(environment, current, now);
          const reopened = current.installAcknowledgements.map(
            (acknowledgement) =>
              environment.authority(acknowledgement.authorityId).reopen({
                acknowledgement,
                operationId,
              }),
          );
          if (reopened.some((item) => !item))
            throw new ControlServiceFailoverError(
              "failover_reopen_ack_missing",
            );
          return save(
            current,
            {
              ...current,
              evidence: Object.freeze({
                ...current.evidence,
                completed: evidenceDigest(reopened),
              }),
              phase: "completed",
            },
            claim,
            now,
          );
        }
        case "completed":
          return current;
      }
    },
    discoverIncomplete: (limit) => store.discoverIncomplete(limit),
  };
  return Object.freeze(coordinator);
}
