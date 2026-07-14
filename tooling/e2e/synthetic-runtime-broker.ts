import type { KeyObject } from "node:crypto";

import {
  RUNTIME_BROKER_CONTRACT_VERSION,
  type RuntimeAuthorityCloseAckV1,
  type RuntimeAuthorityCloseRequestV1,
  type RuntimeAuthorityInstallAckV1,
  type RuntimeAuthorityInstallRequestV1,
  type RuntimeBrokerCapabilitiesV1,
  type RuntimeBrokerClientV1,
  type RuntimeMutationRequestV1,
  type RuntimeOperationReceiptV1,
} from "@workload-funnel/bridge-subscription-runtime/runtime-operation-dispatch";
import {
  compareMutationFence,
  fingerprintMutationFence,
} from "@workload-funnel/kernel";

import { DurableRuntimeBrokerStorage } from "./durable-runtime-broker-state.js";
import { verifyRuntimeAuthorityGrant } from "./runtime-authority-signing.js";
import { authoritySnapshot } from "./synthetic-lifecycle-fixtures.js";
import type { TrustedSyntheticLauncher } from "./trusted-synthetic-launcher.js";

export const runtimeBuildSha = "1".repeat(40);

export class SyntheticRuntimeBroker implements RuntimeBrokerClientV1 {
  public readonly finalMutators = Object.freeze({
    provider: Object.freeze({
      mutate: (request: RuntimeMutationRequestV1 & { boundary: "provider" }) =>
        this.mutate(request),
    }),
    runtime: Object.freeze({
      mutate: (request: RuntimeMutationRequestV1 & { boundary: "runtime" }) =>
        this.mutate(request),
    }),
    session: Object.freeze({
      mutate: (request: RuntimeMutationRequestV1 & { boundary: "session" }) =>
        this.mutate(request),
    }),
  });
  readonly #launcher: TrustedSyntheticLauncher;
  readonly #storage: DurableRuntimeBrokerStorage;
  readonly #trustedAuthorityKeys: ReadonlyMap<string, KeyObject>;

  public constructor(input: {
    readonly directory: string;
    readonly launcher: TrustedSyntheticLauncher;
    readonly trustedAuthorityKeys: ReadonlyMap<string, KeyObject>;
  }) {
    this.#launcher = input.launcher;
    this.#storage = new DurableRuntimeBrokerStorage(input.directory);
    this.#trustedAuthorityKeys = input.trustedAuthorityKeys;
  }

  public get externalStartCount(): number {
    return this.#launcher.externalStartCount;
  }

  public get finalMutationAttempts(): number {
    return this.#storage.state.finalMutationAttempts;
  }

  public closeMutationScope(
    request: RuntimeAuthorityCloseRequestV1,
  ): Promise<RuntimeAuthorityCloseAckV1> {
    const state = this.#storage.state;
    const current = state.authorities.get(request.effectScopeKey);
    if (current !== undefined && current.grant.targetId !== request.targetId) {
      throw new Error("runtime_authority_target_mismatch");
    }
    const prior = state.closures.get(request.effectScopeKey);
    if (
      prior?.changeId === request.changeId &&
      prior.targetId === request.targetId
    ) {
      return Promise.resolve(prior);
    }
    const acknowledgement = Object.freeze({
      changeId: request.changeId,
      effectScopeKey: request.effectScopeKey,
      registryRevision: current?.registryRevision ?? state.registryRevision,
      targetId: request.targetId,
    });
    if (current !== undefined) {
      state.authorities.set(request.effectScopeKey, {
        ...current,
        open: false,
      });
    }
    state.closures.set(request.effectScopeKey, acknowledgement);
    this.#storage.persist();
    return Promise.resolve(acknowledgement);
  }

  public discoverCapabilities(
    targetId: string,
  ): Promise<RuntimeBrokerCapabilitiesV1> {
    return Promise.resolve(
      Object.freeze({
        contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
        cursorSnapshots: true,
        durableOperationReceipts: true,
        foregroundOwnedExecution: true,
        mutationBoundaries: Object.freeze([
          "runtime",
          "provider",
          "session",
        ] as const),
        mutationKinds: Object.freeze([
          "create",
          "start",
          "resume",
          "input",
          "update",
          "checkpoint",
          "stop",
          "cancel",
          "delete",
        ] as const),
        runtimeBuildSha,
        runtimeMutationFencing: true,
        targetId,
      }),
    );
  }

  public findOperation(
    _targetId: string,
    idempotencyKey: string,
  ): Promise<RuntimeOperationReceiptV1 | undefined> {
    return Promise.resolve(
      this.#storage.state.receipts.get(idempotencyKey)?.receipt,
    );
  }

  public installMutationAuthority(
    request: RuntimeAuthorityInstallRequestV1,
  ): Promise<RuntimeAuthorityInstallAckV1> {
    const state = this.#storage.state;
    const { grant } = request;
    verifyRuntimeAuthorityGrant(
      grant,
      request.closeAcknowledgement.targetId,
      this.#trustedAuthorityKeys,
      1_500,
    );
    const scope = grant.mutationFence.effectScopeKey;
    const closure = state.closures.get(scope);
    const current = state.authorities.get(scope);
    if (
      closure?.changeId !== grant.changeId ||
      closure.effectScopeKey !== scope ||
      closure.registryRevision !==
        (current?.registryRevision ?? state.registryRevision) ||
      request.closeAcknowledgement.changeId !== closure.changeId ||
      request.closeAcknowledgement.registryRevision !==
        closure.registryRevision ||
      (grant.expectedPriorFingerprint !== undefined &&
        grant.expectedPriorFingerprint !==
          current?.grant.mutationFenceFingerprint)
    ) {
      throw new Error("runtime_authority_close_ack_stale");
    }
    if (
      current !== undefined &&
      current.grant.mutationFenceFingerprint !== grant.mutationFenceFingerprint
    ) {
      throw new Error("runtime_authority_advance_not_supported_by_fixture");
    }
    this.#launcher.install(grant.mutationFence);
    const registryRevision =
      current?.registryRevision ?? ++state.registryRevision;
    state.authorities.set(scope, {
      grant,
      open: false,
      registryRevision,
    });
    this.#storage.persist();
    return Promise.resolve(
      Object.freeze({
        authorityGrantId: grant.grantId,
        changeId: grant.changeId,
        effectScopeKey: scope,
        mutationFenceFingerprint: grant.mutationFenceFingerprint,
        registryRevision,
        targetId: grant.targetId,
      }),
    );
  }

  public reopenMutationScope(
    acknowledgement: RuntimeAuthorityInstallAckV1,
  ): Promise<void> {
    const state = this.#storage.state;
    const authority = state.authorities.get(acknowledgement.effectScopeKey);
    if (
      authority?.grant.grantId !== acknowledgement.authorityGrantId ||
      authority.grant.changeId !== acknowledgement.changeId ||
      authority.grant.mutationFenceFingerprint !==
        acknowledgement.mutationFenceFingerprint ||
      authority.registryRevision !== acknowledgement.registryRevision ||
      authority.grant.targetId !== acknowledgement.targetId
    ) {
      throw new Error("runtime_authority_reopen_mismatch");
    }
    state.authorities.set(acknowledgement.effectScopeKey, {
      ...authority,
      open: true,
    });
    state.closures.delete(acknowledgement.effectScopeKey);
    this.#storage.persist();
    return Promise.resolve();
  }

  private mutate(
    request: RuntimeMutationRequestV1,
  ): Promise<RuntimeOperationReceiptV1> {
    const state = this.#storage.state;
    state.finalMutationAttempts += 1;
    const prior = state.receipts.get(request.idempotencyKey);
    if (prior !== undefined) {
      if (
        prior.request.intentFingerprint !== request.intentFingerprint ||
        prior.request.mutationFenceFingerprint !==
          request.mutationFenceFingerprint
      ) {
        throw new Error("runtime_idempotency_conflict");
      }
      this.#storage.persist();
      return Promise.resolve(prior.receipt);
    }
    const authority = state.authorities.get(
      request.mutationFence.effectScopeKey,
    );
    const comparison =
      authority === undefined
        ? "tuple_mismatch"
        : compareMutationFence(
            request.mutationFence,
            authoritySnapshot(authority.grant.mutationFence),
            1_500,
          );
    const exact =
      authority?.open === true &&
      comparison === "current" &&
      request.mutationFenceFingerprint ===
        fingerprintMutationFence(request.mutationFence) &&
      request.mutationFenceFingerprint ===
        authority.grant.mutationFenceFingerprint &&
      request.ticket.mutationFenceFingerprint ===
        request.mutationFenceFingerprint;
    if (!exact) {
      const receipt = this.receipt(request, "rejected", comparison);
      state.receipts.set(request.idempotencyKey, { request, receipt });
      this.#storage.persist();
      return Promise.resolve(receipt);
    }
    this.#launcher.start(request.mutationFence);
    const receipt = this.receipt(request, "running");
    state.receipts.set(request.idempotencyKey, { request, receipt });
    this.#storage.persist();
    return Promise.resolve(receipt);
  }

  private receipt(
    request: RuntimeMutationRequestV1,
    state: RuntimeOperationReceiptV1["state"],
    rejectionCode?: string,
  ): RuntimeOperationReceiptV1 {
    return Object.freeze({
      contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      intentFingerprint: request.intentFingerprint,
      mutationFenceFingerprint: request.mutationFenceFingerprint,
      operationId: request.operationId,
      ...(rejectionCode === undefined ? {} : { rejectionCode }),
      runtimeBuildSha,
      runtimeOperationId: `runtime-${request.operationId}`,
      state,
    });
  }
}
