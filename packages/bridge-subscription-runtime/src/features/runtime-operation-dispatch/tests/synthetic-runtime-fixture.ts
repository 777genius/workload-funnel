import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  TargetOperationObservation,
  TargetOperationReceipt,
} from "@workload-funnel/node-execution/process-lifecycle";

import type { RuntimeEventClient } from "../../runtime-event-consumption/index.js";
import type {
  RuntimeReconciliationClient,
  RuntimeReconciliationStore,
} from "../../runtime-operation-reconciliation/index.js";
import {
  RUNTIME_BROKER_CONTRACT_VERSION,
  type DurableRuntimeOperation,
  type RuntimeAuthorityCloseAckV1,
  type RuntimeAuthorityCloseRequestV1,
  type RuntimeAuthorityInstallAckV1,
  type RuntimeAuthorityInstallRequestV1,
  type RuntimeBrokerCapabilitiesV1,
  type RuntimeBrokerClientV1,
  type RuntimeFinalMutatorSetV1,
  type RuntimeMutationRequestV1,
  type RuntimeOperationReceiptV1,
  type RuntimeOperationStore,
} from "../index.js";
import {
  applyHighWatermarks,
  assertCurrentHighWatermarks,
  compareScopeForAdvance,
  nextHighWatermarks,
  verifySyntheticAuthorityGrant,
} from "./synthetic-authority.js";
import type {
  SyntheticAuthority,
  SyntheticEvent,
  SyntheticRuntimeStorage,
} from "./synthetic-runtime-state.js";

export { createSyntheticAuthorityGrant } from "./synthetic-authority.js";
export {
  createSyntheticRuntimeStorage,
  type SyntheticRuntimeStorage,
} from "./synthetic-runtime-state.js";

function exactFence(
  storage: SyntheticRuntimeStorage,
  authority: SyntheticAuthority,
  request: RuntimeMutationRequestV1,
): void {
  const fence = request.mutationFence;
  validateMutationFence(fence);
  if (
    authority.closed ||
    authority.targetId !== request.ticket.runtimeTargetId ||
    request.mutationFenceFingerprint !== fingerprintMutationFence(fence) ||
    request.mutationFenceFingerprint !== authority.fingerprint ||
    fingerprintMutationFence(request.ticket.mutationFence) !==
      request.mutationFenceFingerprint ||
    fence.effectScopeKey !== authority.fence.effectScopeKey ||
    fence.clusterIncarnationVersion !==
      authority.fence.clusterIncarnationVersion ||
    fence.clusterIncarnation !== authority.fence.clusterIncarnation ||
    fence.namespaceWriterEpoch !== authority.fence.namespaceWriterEpoch ||
    fence.ownerFence !== authority.fence.ownerFence ||
    fence.operationGateRevision !== authority.fence.operationGateRevision ||
    fence.issuedStartRevocationRevision !==
      authority.fence.issuedStartRevocationRevision ||
    fence.expectedDesiredVersion !== authority.fence.expectedDesiredVersion ||
    fence.nodeBootEpoch !== authority.fence.nodeBootEpoch ||
    request.ticket.mutationFenceFingerprint !== request.mutationFenceFingerprint
  ) {
    throw new Error("runtime_final_mutator_authority_rejected");
  }
  assertCurrentHighWatermarks(
    storage.highWatermarks,
    fence,
    authority.issuerId,
  );
}

export class SyntheticRuntimeBroker
  implements RuntimeBrokerClientV1, RuntimeEventClient
{
  public beforeFinalMutation:
    | ((request: RuntimeMutationRequestV1) => Promise<void>)
    | undefined;
  public failAfterFinalMutationOnce = false;
  public operationLookupAvailable = true;
  public capabilityDiscoveryCalls = 0;
  public readonly finalMutators: RuntimeFinalMutatorSetV1;
  readonly #buildSha = "a".repeat(40);
  readonly #controllerId: string;
  readonly #soleCredential = Symbol("synthetic-runtime-sole-credential");
  readonly #storage: SyntheticRuntimeStorage;
  #recovered = false;
  #supportsFencing: boolean;

  public constructor(
    storage: SyntheticRuntimeStorage,
    options: {
      readonly controllerId?: string;
      readonly supportsFencing?: boolean;
    } = {},
  ) {
    this.#storage = storage;
    this.#controllerId = options.controllerId ?? "synthetic-controller";
    this.#supportsFencing = options.supportsFencing ?? true;
    this.finalMutators = Object.freeze({
      provider: Object.freeze({
        mutate: (
          request: RuntimeMutationRequestV1 & {
            readonly boundary: "provider";
          },
        ) => this.mutateFinal(request),
      }),
      runtime: Object.freeze({
        mutate: (
          request: RuntimeMutationRequestV1 & {
            readonly boundary: "runtime";
          },
        ) => this.mutateFinal(request),
      }),
      session: Object.freeze({
        mutate: (
          request: RuntimeMutationRequestV1 & {
            readonly boundary: "session";
          },
        ) => this.mutateFinal(request),
      }),
    });
    for (const authority of storage.authorities.values())
      authority.closed = true;
    storage.closures.clear();
    if (storage.authorities.size > 0) storage.persist();
  }

  public recover(authoritativeFence?: MutationFence): void {
    if (authoritativeFence !== undefined) {
      const current = this.#storage.authorities.get(
        authoritativeFence.effectScopeKey,
      );
      if (
        current?.fingerprint !== fingerprintMutationFence(authoritativeFence)
      ) {
        throw new Error("runtime_registry_recovery_uncertain");
      }
      assertCurrentHighWatermarks(
        this.#storage.highWatermarks,
        authoritativeFence,
        current.issuerId,
      );
    }
    this.#recovered = true;
  }

  public setFencingCapability(supported: boolean): void {
    this.#supportsFencing = supported;
  }

  public discoverCapabilities(
    targetId: string,
  ): Promise<RuntimeBrokerCapabilitiesV1> {
    this.capabilityDiscoveryCalls += 1;
    return Promise.resolve({
      contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      cursorSnapshots: true,
      durableOperationReceipts: true,
      foregroundOwnedExecution: true,
      mutationKinds: [
        "create",
        "start",
        "resume",
        "input",
        "update",
        "checkpoint",
        "stop",
        "cancel",
        "delete",
      ],
      mutationBoundaries: ["runtime", "provider", "session"],
      runtimeBuildSha: this.#buildSha,
      runtimeMutationFencing: this.#supportsFencing && this.#recovered,
      targetId,
    });
  }

  public closeMutationScope(
    request: RuntimeAuthorityCloseRequestV1,
  ): Promise<RuntimeAuthorityCloseAckV1> {
    this.assertRecovered();
    const authority = this.#storage.authorities.get(request.effectScopeKey);
    if (authority !== undefined && authority.targetId !== request.targetId) {
      throw new Error("runtime_authority_target_mismatch");
    }
    this.#storage.registryMutations += 1;
    if (authority !== undefined) authority.closed = true;
    const acknowledgement = {
      changeId: request.changeId,
      effectScopeKey: request.effectScopeKey,
      registryRevision: authority?.registryRevision ?? 0,
      targetId: request.targetId,
    };
    this.#storage.closures.set(request.effectScopeKey, acknowledgement);
    this.#storage.persist();
    return Promise.resolve(acknowledgement);
  }

  public installMutationAuthority(
    request: RuntimeAuthorityInstallRequestV1,
  ): Promise<RuntimeAuthorityInstallAckV1> {
    this.assertRecovered();
    const { grant } = request;
    verifySyntheticAuthorityGrant(grant, request.closeAcknowledgement.targetId);
    const fence: MutationFence = grant.mutationFence;
    validateMutationFence(fence);
    if (
      request.closeAcknowledgement.changeId !== grant.changeId ||
      request.closeAcknowledgement.effectScopeKey !== fence.effectScopeKey ||
      grant.mutationFenceFingerprint !== fingerprintMutationFence(fence)
    ) {
      throw new Error("runtime_authority_install_request_mismatch");
    }
    const current = this.#storage.authorities.get(fence.effectScopeKey);
    const closure = this.#storage.closures.get(fence.effectScopeKey);
    if (
      closure?.changeId !== grant.changeId ||
      closure.registryRevision !== (current?.registryRevision ?? 0) ||
      closure.targetId !== request.closeAcknowledgement.targetId
    ) {
      throw new Error("runtime_authority_close_ack_stale");
    }
    if (
      grant.expectedPriorFingerprint !== undefined &&
      current?.fingerprint !== grant.expectedPriorFingerprint
    ) {
      throw new Error("runtime_authority_prior_mismatch");
    }
    const highWatermarks = nextHighWatermarks(
      this.#storage.highWatermarks,
      grant,
    );
    if (current !== undefined) {
      compareScopeForAdvance(current, grant);
      if (!current.closed) {
        throw new Error("runtime_authority_advance_requires_closed_scope");
      }
    }
    this.#storage.registryMutations += 1;
    const registryRevision = (current?.registryRevision ?? 0) + 1;
    this.#storage.authorities.set(fence.effectScopeKey, {
      changeId: grant.changeId,
      closed: true,
      fence,
      fingerprint: grant.mutationFenceFingerprint,
      grantId: grant.grantId,
      issuerId: grant.issuerId,
      registryRevision,
      targetId: request.closeAcknowledgement.targetId,
    });
    applyHighWatermarks(this.#storage, highWatermarks);
    this.#storage.persist();
    return Promise.resolve({
      authorityGrantId: grant.grantId,
      changeId: grant.changeId,
      effectScopeKey: fence.effectScopeKey,
      mutationFenceFingerprint: grant.mutationFenceFingerprint,
      registryRevision,
      targetId: request.closeAcknowledgement.targetId,
    });
  }

  public reopenMutationScope(
    acknowledgement: RuntimeAuthorityInstallAckV1,
  ): Promise<void> {
    this.assertRecovered();
    const authority = this.#storage.authorities.get(
      acknowledgement.effectScopeKey,
    );
    if (
      authority?.changeId !== acknowledgement.changeId ||
      authority.grantId !== acknowledgement.authorityGrantId ||
      authority.fingerprint !== acknowledgement.mutationFenceFingerprint ||
      authority.registryRevision !== acknowledgement.registryRevision ||
      authority.targetId !== acknowledgement.targetId
    ) {
      throw new Error("runtime_authority_reopen_mismatch");
    }
    this.#storage.registryMutations += 1;
    authority.closed = false;
    this.#storage.persist();
    return Promise.resolve();
  }

  public findOperation(
    _targetId: string,
    idempotencyKey: string,
  ): Promise<RuntimeOperationReceiptV1 | undefined> {
    if (!this.operationLookupAvailable) {
      throw new Error("synthetic_runtime_lookup_unavailable");
    }
    return Promise.resolve(this.#storage.receipts.get(idempotencyKey));
  }

  private async mutateFinal(
    request: RuntimeMutationRequestV1,
  ): Promise<RuntimeOperationReceiptV1> {
    this.assertRecovered();
    await this.beforeFinalMutation?.(request);
    const authority = this.#storage.authorities.get(
      request.mutationFence.effectScopeKey,
    );
    if (authority === undefined) throw new Error("runtime_authority_missing");
    exactFence(this.#storage, authority, request);
    const prior = this.#storage.receipts.get(request.idempotencyKey);
    if (prior !== undefined) {
      const priorRequest = this.#storage.receiptRequests.get(
        request.idempotencyKey,
      );
      if (
        priorRequest?.intentFingerprint !== request.intentFingerprint ||
        priorRequest.mutationFenceFingerprint !==
          request.mutationFenceFingerprint
      ) {
        throw new Error("runtime_idempotency_conflict");
      }
      return prior;
    }
    this.commitFinalMutation(request, this.#soleCredential);
    const runtimeOperationId = `runtime-operation-${String(
      this.#storage.finalMutationCalls,
    )}`;
    const receipt: RuntimeOperationReceiptV1 = Object.freeze({
      contractVersion: RUNTIME_BROKER_CONTRACT_VERSION,
      intentFingerprint: request.intentFingerprint,
      mutationFenceFingerprint: request.mutationFenceFingerprint,
      operationId: request.operationId,
      runtimeBuildSha: this.#buildSha,
      runtimeOperationId,
      state: "accepted",
    });
    this.#storage.receipts.set(request.idempotencyKey, receipt);
    this.#storage.receiptRequests.set(request.idempotencyKey, request);
    this.appendEvent(request, runtimeOperationId, "starting");
    this.#storage.persist();
    if (this.failAfterFinalMutationOnce) {
      this.failAfterFinalMutationOnce = false;
      throw new Error("synthetic_runtime_response_lost");
    }
    return receipt;
  }

  public appendRunState(
    idempotencyKey: string,
    state: "running" | "exited" | "stopped",
    terminal?: SyntheticEvent["terminal"],
  ): void {
    const request = this.#storage.receiptRequests.get(idempotencyKey);
    const receipt = this.#storage.receipts.get(idempotencyKey);
    if (request === undefined || receipt === undefined) {
      throw new Error("synthetic_runtime_operation_missing");
    }
    this.appendEvent(request, receipt.runtimeOperationId, state, terminal);
    this.#storage.persist();
  }

  public readEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<unknown> {
    const offset =
      cursor === undefined ? 0 : Number(cursor.slice("cursor-".length));
    const events = this.#storage.events.slice(offset, offset + limit);
    const nextOffset = offset + events.length;
    return Promise.resolve({
      schemaVersion: "subscription-runtime.event-page.v1",
      events,
      ...(nextOffset < this.#storage.events.length
        ? { nextCursor: `cursor-${String(nextOffset)}` }
        : events.length === 0
          ? {}
          : { nextCursor: `cursor-${String(nextOffset)}` }),
    });
  }

  public readProjectSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<unknown> {
    const offset =
      pageToken === undefined ? 0 : Number(pageToken.slice("snapshot-".length));
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("synthetic_snapshot_page_unknown");
    }
    const all = [...this.#storage.latest.values()].sort((left, right) =>
      left.runtimeOperationId.localeCompare(right.runtimeOperationId),
    );
    const entries = all.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;
    return Promise.resolve({
      schemaVersion: "subscription-runtime.snapshot-page.v1",
      entries,
      ...(nextOffset < all.length
        ? { nextPageToken: `snapshot-${String(nextOffset)}` }
        : {}),
    });
  }

  private appendEvent(
    request: RuntimeMutationRequestV1,
    runtimeOperationId: string,
    state: SyntheticEvent["state"],
    terminal?: SyntheticEvent["terminal"],
  ): void {
    this.#storage.sequence += 1;
    const event: SyntheticEvent = Object.freeze({
      causationId: request.causationId,
      controllerId: this.#controllerId,
      cursor: `cursor-${String(this.#storage.sequence)}`,
      operationId: request.operationId,
      projectId: request.ticket.projectId,
      runtimeBuildSha: this.#buildSha,
      runtimeOperationId,
      schemaVersion: "subscription-runtime.event.v1",
      sourceRevision: this.#storage.sequence,
      state,
      targetId: request.ticket.runtimeTargetId,
      ...(terminal === undefined ? {} : { terminal }),
    });
    this.#storage.events.push(event);
    this.#storage.latest.set(runtimeOperationId, event);
  }

  private assertRecovered(): void {
    if (!this.#recovered || !this.#supportsFencing) {
      throw new Error("runtime_registry_not_recovered");
    }
  }

  private commitFinalMutation(
    request: RuntimeMutationRequestV1,
    credential: symbol,
  ): void {
    if (credential !== this.#soleCredential) {
      throw new Error("runtime_final_mutator_credential_rejected");
    }
    this.#storage.boundaryMutationCalls[request.boundary] += 1;
    this.#storage.finalMutationCalls += 1;
  }
}

export class InMemoryRuntimeOperationStore implements RuntimeOperationStore {
  readonly #records: Map<string, DurableRuntimeOperation>;
  public mutationCount = 0;

  public constructor(records = new Map<string, DurableRuntimeOperation>()) {
    this.#records = records;
  }

  public get durableRecords(): Map<string, DurableRuntimeOperation> {
    return this.#records;
  }

  public find(
    idempotencyKey: string,
  ): Promise<DurableRuntimeOperation | undefined> {
    return Promise.resolve(this.#records.get(idempotencyKey));
  }

  public reserve(
    operation: DurableRuntimeOperation,
  ): Promise<DurableRuntimeOperation> {
    const prior = this.#records.get(operation.idempotencyKey);
    if (prior !== undefined) return Promise.resolve(prior);
    this.mutationCount += 1;
    this.#records.set(operation.idempotencyKey, operation);
    return Promise.resolve(operation);
  }

  public save(
    operation: DurableRuntimeOperation,
    receipt: TargetOperationReceipt,
  ): Promise<DurableRuntimeOperation> {
    this.mutationCount += 1;
    const recorded = Object.freeze({
      ...operation,
      receipt,
      state: "recorded" as const,
    });
    this.#records.set(operation.idempotencyKey, recorded);
    return Promise.resolve(recorded);
  }

  public saveUnknown(
    operation: DurableRuntimeOperation,
  ): Promise<DurableRuntimeOperation> {
    this.mutationCount += 1;
    const unknown = Object.freeze({ ...operation, state: "unknown" as const });
    this.#records.set(operation.idempotencyKey, unknown);
    return Promise.resolve(unknown);
  }
}

export class InMemoryReconciliationStore implements RuntimeReconciliationStore {
  readonly #observations = new Map<string, TargetOperationObservation>();
  #cursor: string | undefined;

  public checkpoint(): Promise<string | undefined> {
    return Promise.resolve(this.#cursor);
  }

  public applyEventBatch(
    events: readonly TargetOperationObservation[],
    checkpoint: string | undefined,
  ): Promise<void> {
    const next = new Map(this.#observations);
    for (const event of events) {
      const prior = next.get(event.runtimeOperationId);
      if (prior === undefined || event.sourceRevision > prior.sourceRevision) {
        next.set(event.runtimeOperationId, event);
      } else if (
        event.sourceRevision === prior.sourceRevision &&
        event.state !== prior.state
      ) {
        throw new Error("runtime_event_equal_revision_mismatch");
      }
    }
    this.#observations.clear();
    for (const [key, value] of next) this.#observations.set(key, value);
    this.#cursor = checkpoint;
    return Promise.resolve();
  }

  public list(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    readonly entries: readonly TargetOperationObservation[];
    readonly nextCursor?: string;
  }> {
    const offset =
      cursor === undefined ? 0 : Number(cursor.slice("memory-".length));
    const all = [...this.#observations.values()].sort((left, right) =>
      left.runtimeOperationId.localeCompare(right.runtimeOperationId),
    );
    const entries = all.slice(offset, offset + limit);
    const next = offset + entries.length;
    return Promise.resolve({
      entries,
      ...(next < all.length ? { nextCursor: `memory-${String(next)}` } : {}),
    });
  }

  public saveSnapshotObservation(
    observation: TargetOperationObservation,
  ): Promise<void> {
    this.#observations.set(observation.runtimeOperationId, observation);
    return Promise.resolve();
  }
}

export function asReconciliationClient(source: {
  readEvents(
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    readonly events: readonly TargetOperationObservation[];
    readonly nextCursor?: string;
  }>;
  readSnapshot(
    pageToken: string | undefined,
    limit: number,
  ): Promise<{
    readonly entries: readonly TargetOperationObservation[];
    readonly nextPageToken?: string;
  }>;
}): RuntimeReconciliationClient {
  return source;
}
