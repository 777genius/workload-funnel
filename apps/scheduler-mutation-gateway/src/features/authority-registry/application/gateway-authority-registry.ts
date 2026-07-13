import type { MutationFence } from "@workload-funnel/kernel";
import { GatewayContractError } from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";
import {
  createSchedulerAuthorityHighWatermarks,
  schedulerMutationScopeKey,
  schedulerAuthoritySerializationKeys,
  type AuthorizedHyperQueueMutation,
  type EffectReceiptEvidence,
  type MutateHyperQueueRequest,
  type SchedulerScopeCloseAcknowledgement,
  type SchedulerScopeCloseRequest,
  type SchedulerScopeReopenRequest,
  type SignedSchedulerFenceInstall,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import {
  EffectOperationRegistry,
  type PrepareGatewayMutation,
} from "./effect-operation-registry.js";
import { FenceInstallationRegistry } from "./fence-installation-registry.js";
import type {
  GatewayRegistryRuntime,
  ScopeState,
} from "./gateway-registry-runtime.js";
import type { GatewayWal } from "./gateway-wal.js";
import { ScopeSerializer } from "./scope-serializer.js";

export type { PrepareGatewayMutation } from "./effect-operation-registry.js";

export interface GatewayAuthorityRegistryConfig {
  readonly acknowledgementKey: Uint8Array;
  readonly authorityId: string;
  readonly nowMs: () => number;
  readonly trustedInstallKeys: ReadonlyMap<string, Uint8Array>;
  readonly wal: GatewayWal;
}

export class GatewayAuthorityRegistry {
  readonly #effects: EffectOperationRegistry;
  readonly #installation: FenceInstallationRegistry;
  readonly #runtime: GatewayRegistryRuntime;
  #cordonReason: string | undefined;

  public constructor(private readonly config: GatewayAuthorityRegistryConfig) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(config.authorityId) ||
      config.acknowledgementKey.byteLength < 32 ||
      config.trustedInstallKeys.size < 1 ||
      [...config.trustedInstallKeys].some(
        ([keyId, key]) =>
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(keyId) ||
          key.byteLength < 32,
      )
    )
      throw new Error("gateway_authority_configuration_invalid");
    const scopes = new Map<string, ScopeState>();
    const serializer = new ScopeSerializer();
    const highWatermarks = createSchedulerAuthorityHighWatermarks();
    this.#runtime = {
      ...config,
      assertHealthy: () => {
        this.assertHealthy();
      },
      authorityRevalidationRequired: () =>
        [...scopes.values()].some(
          (state) =>
            !state.invalidatedByCrossScope && state.startupRevalidationRequired,
        ),
      closing: new Set<string>(),
      highWatermarks,
      scopes,
      serializer,
    };
    this.#effects = new EffectOperationRegistry(this.#runtime);
    this.#installation = new FenceInstallationRegistry(
      this.#runtime,
      (scopeKey) => this.#effects.hasUnresolvedInScope(scopeKey),
    );
    if (config.wal.cordonReason !== undefined) {
      this.#cordonReason = "gateway_registry_unprovable";
    } else {
      try {
        for (const envelope of config.wal.records) {
          if (
            !this.#installation.applyRecoveredRecord(
              envelope.record,
              envelope.sequence,
            ) &&
            !this.#effects.applyRecoveredRecord(
              envelope.record,
              envelope.sequence,
            )
          )
            throw new Error("unknown_gateway_wal_record");
        }
        for (const state of scopes.values()) {
          if (state.fence === undefined || state.invalidatedByCrossScope)
            continue;
          state.closed = true;
          state.startupRevalidationRequired = true;
        }
      } catch {
        this.#cordonReason = "gateway_registry_unprovable";
      }
    }
  }

  public get cordonReason(): string | undefined {
    return this.#cordonReason ?? this.config.wal.cordonReason;
  }

  public get authorityRevalidationRequired(): boolean {
    return this.#runtime.authorityRevalidationRequired();
  }

  public closeAndDrain(
    request: SchedulerScopeCloseRequest,
  ): Promise<SchedulerScopeCloseAcknowledgement> {
    return this.#installation.closeAndDrain(request);
  }

  public install(
    request: SignedSchedulerFenceInstall,
  ): Promise<SignedSchedulerFenceInstallAcknowledgement> {
    return this.#installation.install(request);
  }

  public reopen(request: SchedulerScopeReopenRequest): Promise<void> {
    return this.#installation.reopen(request);
  }

  public async queueMutation<T>(
    request: MutateHyperQueueRequest,
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertHealthy();
    const exactScopeKey = schedulerMutationScopeKey(request.scope);
    const mutationFence: MutationFence = request.mutationFence;
    const scopeKeys = [
      ...schedulerAuthoritySerializationKeys(mutationFence, request.scope),
      ...(request.submitRevocationAcknowledgement === undefined
        ? []
        : this.serializationKeysForAcknowledgedScope(
            request.submitRevocationAcknowledgement.claims.scope,
          )),
    ]
      .filter((key, index, keys) => keys.indexOf(key) === index)
      .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    const releaseQueueReservation =
      this.#runtime.serializer.reserveQueuePosition(exactScopeKey);
    const serialize = (index: number): Promise<T> => {
      const scopeKey = scopeKeys[index];
      if (scopeKey === undefined) return work();
      return this.#runtime.serializer.run(scopeKey, () => {
        if (scopeKey === exactScopeKey) releaseQueueReservation();
        return serialize(index + 1);
      });
    };
    try {
      return await serialize(0);
    } finally {
      releaseQueueReservation();
    }
  }

  private serializationKeysForAcknowledgedScope(
    scope: Parameters<typeof schedulerMutationScopeKey>[0],
  ): readonly string[] {
    const state = this.#runtime.scopes.get(schedulerMutationScopeKey(scope));
    return state?.fence === undefined
      ? [schedulerMutationScopeKey(scope)]
      : schedulerAuthoritySerializationKeys(state.fence, scope);
  }

  public prepareMutation(
    request: MutateHyperQueueRequest,
  ): PrepareGatewayMutation {
    return this.#effects.prepareMutation(request);
  }

  public replayReceipt(
    request: MutateHyperQueueRequest,
  ): EffectReceiptEvidence | undefined {
    return this.#effects.replayReceipt(request);
  }

  public completeMutation(
    authorization: AuthorizedHyperQueueMutation,
    result: Readonly<{
      externalMappingOrInvocationId?: string;
      outcome: "applied" | "rejected" | "superseded" | "unknown";
      reason: string;
    }>,
  ): EffectReceiptEvidence {
    return this.#effects.completeMutation(authorization, result);
  }

  public recoverUnresolvedAsUnknown(): readonly EffectReceiptEvidence[] {
    return this.#effects.recoverUnresolvedAsUnknown();
  }

  private assertHealthy(): void {
    const reason = this.cordonReason;
    if (reason !== undefined)
      throw new GatewayContractError("gateway_cordoned", reason);
  }
}
