import type {
  TargetAuthorityCloseAcknowledgement,
  TargetAuthorityCloseRequest,
  TargetAuthorityInstallAcknowledgement,
  TargetAuthorityInstallRequest,
  TargetOperationDispatcher,
  TargetOperationIntent,
  TargetOperationReceipt,
} from "@workload-funnel/node-execution/process-lifecycle";
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  RUNTIME_BROKER_CONTRACT_VERSION,
  type RuntimeAuthorityInstallAckV1,
  type RuntimeBrokerClientV1,
  type RuntimeMutationRequestV1,
  type RuntimeOperationReceiptV1,
} from "./contracts/runtime-broker-client.js";
import type {
  DurableRuntimeOperation,
  RuntimeOperationStore,
} from "./contracts/runtime-operation-store.js";
import {
  assertRuntimeIntent,
  assertCanonicalAuthorityGrant,
  capabilityDecision,
  isExactOperation,
  mapRuntimeReceipt,
  rejectedReceipt,
  runtimeIntentFingerprint,
  type TargetIncapableReason,
} from "./runtime-dispatch-policy.js";

export interface RuntimeDispatcherDependencies {
  readonly client: RuntimeBrokerClientV1;
  readonly store: RuntimeOperationStore;
}

async function capabilityReason(
  client: RuntimeBrokerClientV1,
  intent?: TargetOperationIntent,
  targetId = intent?.ticket.runtimeTargetId,
): Promise<TargetIncapableReason | undefined> {
  if (targetId === undefined) return "contract_version_unsupported";
  try {
    return capabilityDecision(
      await client.discoverCapabilities(targetId),
      targetId,
      intent,
    );
  } catch {
    return "contract_version_unsupported";
  }
}

export class DurableRuntimeDispatcher implements TargetOperationDispatcher {
  readonly #client: RuntimeBrokerClientV1;
  readonly #store: RuntimeOperationStore;

  public constructor(dependencies: RuntimeDispatcherDependencies) {
    this.#client = dependencies.client;
    this.#store = dependencies.store;
  }

  public async dispatch(
    intent: TargetOperationIntent,
  ): Promise<TargetOperationReceipt> {
    assertRuntimeIntent(intent);
    const fingerprint = runtimeIntentFingerprint(intent);
    const pending: DurableRuntimeOperation = Object.freeze({
      boundary: intent.boundary,
      idempotencyKey: intent.ticket.idempotencyKey,
      intentFingerprint: fingerprint,
      mutationFenceFingerprint: intent.ticket.mutationFenceFingerprint,
      operationId: intent.ticket.operationId,
      runtimeTargetId: intent.ticket.runtimeTargetId,
      state: "pending",
    });
    const prior = await this.#store.find(pending.idempotencyKey);
    if (prior !== undefined && !isExactOperation(prior, intent, fingerprint)) {
      return rejectedReceipt(intent, "idempotency_conflict");
    }
    if (prior?.receipt !== undefined) return prior.receipt;
    const reason = await capabilityReason(this.#client, intent);
    if (reason !== undefined) return rejectedReceipt(intent, reason);

    const operation = prior ?? (await this.#store.reserve(pending));
    if (!isExactOperation(operation, intent, fingerprint)) {
      return rejectedReceipt(intent, "idempotency_conflict");
    }
    if (operation.receipt !== undefined) return operation.receipt;

    let recovered: RuntimeOperationReceiptV1 | undefined;
    try {
      recovered = await this.#client.findOperation(
        operation.runtimeTargetId,
        operation.idempotencyKey,
      );
    } catch {
      return this.recordUnknown(operation);
    }
    if (recovered !== undefined) {
      const receipt = mapRuntimeReceipt(recovered, operation);
      await this.#store.save(operation, receipt);
      return receipt;
    }

    const request: RuntimeMutationRequestV1 = {
      boundary: intent.boundary,
      causationId: intent.ticket.causationId,
      contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      correlationId: intent.ticket.correlationId,
      idempotencyKey: intent.ticket.idempotencyKey,
      intentFingerprint: fingerprint,
      kind: intent.kind,
      mutationFence: intent.ticket.mutationFence,
      mutationFenceFingerprint: intent.ticket.mutationFenceFingerprint,
      operationId: intent.ticket.operationId,
      ...(intent.payloadDigest === undefined
        ? {}
        : { payloadDigest: intent.payloadDigest }),
      requestId: intent.ticket.requestId,
      ticket: intent.ticket,
    };
    try {
      const receipt = mapRuntimeReceipt(await this.mutate(request), operation);
      await this.#store.save(operation, receipt);
      return receipt;
    } catch {
      let afterFailure: RuntimeOperationReceiptV1 | undefined;
      try {
        afterFailure = await this.#client.findOperation(
          operation.runtimeTargetId,
          operation.idempotencyKey,
        );
      } catch {
        return this.recordUnknown(operation);
      }
      if (afterFailure !== undefined) {
        const receipt = mapRuntimeReceipt(afterFailure, operation);
        await this.#store.save(operation, receipt);
        return receipt;
      }
      return this.recordUnknown(operation);
    }
  }

  public async closeAuthority(
    request: TargetAuthorityCloseRequest,
  ): Promise<TargetAuthorityCloseAcknowledgement> {
    const reason = await capabilityReason(
      this.#client,
      undefined,
      request.targetId,
    );
    if (reason !== undefined) {
      throw new Error(`runtime_target_incapable:${reason}`);
    }
    const acknowledgement = await this.#client.closeMutationScope({
      changeId: request.changeId,
      contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      effectScopeKey: request.effectScopeKey,
      targetId: request.targetId,
    });
    return Object.freeze({ ...acknowledgement });
  }

  public async installAuthority(
    request: TargetAuthorityInstallRequest,
  ): Promise<TargetAuthorityInstallAcknowledgement> {
    assertCanonicalAuthorityGrant(request.grant);
    const mutationFence: MutationFence = request.grant.mutationFence;
    validateMutationFence(mutationFence);
    if (
      request.grant.mutationFenceFingerprint !==
        fingerprintMutationFence(mutationFence) ||
      request.closeAcknowledgement.effectScopeKey !==
        mutationFence.effectScopeKey ||
      request.closeAcknowledgement.changeId !== request.grant.changeId ||
      request.closeAcknowledgement.targetId !== request.grant.targetId
    ) {
      throw new Error("runtime_authority_install_mismatch");
    }
    const reason = await capabilityReason(
      this.#client,
      undefined,
      request.closeAcknowledgement.targetId,
    );
    if (reason !== undefined) {
      throw new Error(`runtime_target_incapable:${reason}`);
    }
    const acknowledgement: RuntimeAuthorityInstallAckV1 =
      await this.#client.installMutationAuthority({
        grant: request.grant,
        closeAcknowledgement: request.closeAcknowledgement,
        contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      });
    return Object.freeze({ ...acknowledgement });
  }

  public async reopenAuthority(
    acknowledgement: TargetAuthorityInstallAcknowledgement,
  ): Promise<void> {
    const reason = await capabilityReason(
      this.#client,
      undefined,
      acknowledgement.targetId,
    );
    if (reason !== undefined) {
      throw new Error(`runtime_target_incapable:${reason}`);
    }
    await this.#client.reopenMutationScope(acknowledgement);
  }

  private async recordUnknown(
    operation: DurableRuntimeOperation,
  ): Promise<TargetOperationReceipt> {
    await this.#store.saveUnknown(operation);
    return Object.freeze({
      mutationFenceFingerprint: operation.mutationFenceFingerprint,
      operationId: operation.operationId,
      state: "unknown",
    });
  }

  private mutate(
    request: RuntimeMutationRequestV1,
  ): Promise<RuntimeOperationReceiptV1> {
    switch (request.boundary) {
      case "runtime":
        return this.#client.finalMutators.runtime.mutate({
          ...request,
          boundary: "runtime",
        });
      case "provider":
        return this.#client.finalMutators.provider.mutate({
          ...request,
          boundary: "provider",
        });
      case "session":
        return this.#client.finalMutators.session.mutate({
          ...request,
          boundary: "session",
        });
    }
  }
}
