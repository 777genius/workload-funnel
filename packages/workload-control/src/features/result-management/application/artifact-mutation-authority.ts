import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export interface ArtifactMutationAuthorityReceipt {
  readonly operationId: string;
  readonly effectScopeKey: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly durableSequence: number;
  readonly writerIdentity: string;
}

export interface ArtifactAuthorityWatermark {
  readonly component: string;
  readonly key: string;
  readonly identity: string;
  readonly version: number;
}

export interface ArtifactMutationAuthorityTransaction {
  getInstalledScope(
    effectScopeKey: string,
  ): ArtifactMutationAuthorityReceipt | undefined;
  getInstallOperation(
    operationId: string,
  ): ArtifactMutationAuthorityReceipt | undefined;
  getWatermark(storageKey: string): ArtifactAuthorityWatermark | undefined;
  nextSequence(): number;
  putInstalledScope(receipt: ArtifactMutationAuthorityReceipt): void;
  putInstallOperation(receipt: ArtifactMutationAuthorityReceipt): void;
  putWatermark(storageKey: string, watermark: ArtifactAuthorityWatermark): void;
}

export interface ArtifactMutationAuthorityStore {
  readonly capabilities: Readonly<{
    crashSafe: boolean;
    recovered: boolean;
    transactional: boolean;
  }>;
  transaction<T>(
    callback: (transaction: ArtifactMutationAuthorityTransaction) => T,
  ): T;
}

export interface InMemoryArtifactMutationAuthorityTestState {
  readonly recovered: boolean;
  readonly installedScopes: Map<string, ArtifactMutationAuthorityReceipt>;
  readonly installOperations: Map<string, ArtifactMutationAuthorityReceipt>;
  readonly watermarks: Map<string, ArtifactAuthorityWatermark>;
  sequence: number;
}

export interface ArtifactMutationAuthority {
  install(
    input: Readonly<{
      operationId: string;
      mutationFence: MutationFence;
      writerIdentity: string;
      expectedPriorFingerprint?: string;
      now: number;
    }>,
  ): ArtifactMutationAuthorityReceipt;
  authorize(
    mutationFence: MutationFence,
    now: number,
  ): ArtifactMutationAuthorityReceipt;
}

export class ArtifactMutationAuthorityError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ArtifactMutationAuthorityError";
  }
}

function tuple(...values: readonly string[]): string {
  return values.join("\u0000");
}

function watermark(
  component: string,
  key: string,
  version: number,
  identity: string,
): ArtifactAuthorityWatermark {
  return Object.freeze({ component, identity, key, version });
}

function watermarks(
  fence: MutationFence,
  writerIdentity: string,
): readonly ArtifactAuthorityWatermark[] {
  const result = [
    watermark(
      "cluster",
      "artifact-authority",
      fence.clusterIncarnationVersion,
      fence.clusterIncarnation,
    ),
    watermark(
      "namespace",
      fence.namespaceId,
      fence.namespaceWriterEpoch,
      writerIdentity,
    ),
    watermark(
      "gate",
      tuple(fence.namespaceId, fence.requiredGate),
      fence.operationGateRevision,
      fence.requiredGate,
    ),
    watermark(
      "desired",
      fence.effectScopeKey,
      fence.expectedDesiredVersion,
      tuple(fence.desiredEffect, fence.supersessionKey),
    ),
  ];
  if (fence.allocationId !== undefined && fence.ownerFence !== undefined)
    result.push(
      watermark(
        "allocation",
        fence.allocationId,
        fence.ownerFence,
        tuple(fence.allocationId, fence.attemptId, fence.executionGeneration),
      ),
    );
  if (
    fence.startFence !== undefined &&
    fence.issuedStartRevocationRevision !== undefined
  )
    result.push(
      watermark(
        "attempt",
        tuple(fence.attemptId, fence.executionGeneration),
        fence.issuedStartRevocationRevision,
        fence.startFence,
      ),
    );
  if (fence.nodeId !== undefined && fence.nodeBootEpoch !== undefined)
    result.push(
      watermark("node", fence.nodeId, fence.nodeBootEpoch, fence.nodeId),
    );
  return Object.freeze(result);
}

function storageKey(value: ArtifactAuthorityWatermark): string {
  return `${value.component}\u0000${value.key}`;
}

export function createInMemoryArtifactMutationAuthorityTestState(): InMemoryArtifactMutationAuthorityTestState {
  return {
    installOperations: new Map(),
    installedScopes: new Map(),
    recovered: true,
    sequence: 0,
    watermarks: new Map(),
  };
}

export function createInMemoryArtifactMutationAuthorityStoreTestFake(
  state: InMemoryArtifactMutationAuthorityTestState,
): ArtifactMutationAuthorityStore {
  const transaction: ArtifactMutationAuthorityTransaction = {
    getInstalledScope: (key) => state.installedScopes.get(key),
    getInstallOperation: (key) => state.installOperations.get(key),
    getWatermark: (key) => state.watermarks.get(key),
    nextSequence: () => ++state.sequence,
    putInstalledScope: (value) =>
      state.installedScopes.set(value.effectScopeKey, value),
    putInstallOperation: (value) =>
      state.installOperations.set(value.operationId, value),
    putWatermark: (key, value) => state.watermarks.set(key, value),
  };
  const store: ArtifactMutationAuthorityStore = {
    capabilities: Object.freeze({
      crashSafe: false,
      recovered: state.recovered,
      transactional: true,
    }),
    transaction: (callback) => callback(transaction),
  };
  return Object.freeze(store);
}

function createArtifactMutationAuthority(
  store: ArtifactMutationAuthorityStore,
  allowTestFake: boolean,
): ArtifactMutationAuthority {
  function assertHealthy(): void {
    if (
      (!store.capabilities.crashSafe && !allowTestFake) ||
      !store.capabilities.recovered ||
      !store.capabilities.transactional
    )
      throw new ArtifactMutationAuthorityError("artifact_authority_cordoned");
  }
  const authority: ArtifactMutationAuthority = {
    install(input) {
      assertHealthy();
      validateMutationFence(input.mutationFence);
      if (
        input.mutationFence.notBefore === undefined ||
        input.mutationFence.notAfter === undefined ||
        input.now < input.mutationFence.notBefore ||
        input.now >= input.mutationFence.notAfter
      )
        throw new ArtifactMutationAuthorityError(
          "artifact_authority_validity_rejected",
        );
      if (!input.writerIdentity)
        throw new ArtifactMutationAuthorityError(
          "artifact_writer_identity_missing",
        );
      if (
        !["artifact_stage", "artifact_delete"].includes(
          input.mutationFence.desiredEffect,
        )
      )
        throw new ArtifactMutationAuthorityError(
          "artifact_effect_not_mutating",
        );
      const fingerprint = fingerprintMutationFence(input.mutationFence);
      return store.transaction((transaction) => {
        const priorOperation = transaction.getInstallOperation(
          input.operationId,
        );
        if (priorOperation !== undefined) {
          if (
            priorOperation.mutationFenceFingerprint !== fingerprint ||
            priorOperation.writerIdentity !== input.writerIdentity
          )
            throw new ArtifactMutationAuthorityError(
              "artifact_install_operation_conflict",
            );
          return priorOperation;
        }
        const priorScope = transaction.getInstalledScope(
          input.mutationFence.effectScopeKey,
        );
        if (
          input.expectedPriorFingerprint !== undefined &&
          priorScope?.mutationFenceFingerprint !==
            input.expectedPriorFingerprint
        )
          throw new ArtifactMutationAuthorityError(
            "artifact_prior_fence_mismatch",
          );
        let dominates = priorScope === undefined;
        const candidates = watermarks(
          input.mutationFence,
          input.writerIdentity,
        );
        for (const candidate of candidates) {
          const current = transaction.getWatermark(storageKey(candidate));
          if (current === undefined || candidate.version > current.version) {
            dominates = true;
            continue;
          }
          if (candidate.version < current.version)
            throw new ArtifactMutationAuthorityError(
              "artifact_authority_stale",
            );
          if (candidate.identity !== current.identity)
            throw new ArtifactMutationAuthorityError(
              "artifact_authority_equal_version_mismatch",
            );
        }
        if (
          priorScope !== undefined &&
          priorScope.mutationFenceFingerprint !== fingerprint &&
          !dominates
        )
          throw new ArtifactMutationAuthorityError(
            "artifact_authority_complete_tuple_mismatch",
          );
        for (const candidate of candidates)
          transaction.putWatermark(storageKey(candidate), candidate);
        const receipt = Object.freeze({
          durableSequence: transaction.nextSequence(),
          effectScopeKey: input.mutationFence.effectScopeKey,
          mutationFence: input.mutationFence,
          mutationFenceFingerprint: fingerprint,
          operationId: input.operationId,
          writerIdentity: input.writerIdentity,
        });
        transaction.putInstallOperation(receipt);
        transaction.putInstalledScope(receipt);
        return receipt;
      });
    },
    authorize(mutationFence, now) {
      assertHealthy();
      validateMutationFence(mutationFence);
      if (
        mutationFence.notBefore === undefined ||
        mutationFence.notAfter === undefined ||
        now < mutationFence.notBefore ||
        now >= mutationFence.notAfter
      )
        throw new ArtifactMutationAuthorityError(
          "artifact_authority_validity_rejected",
        );
      const fingerprint = fingerprintMutationFence(mutationFence);
      return store.transaction((transaction) => {
        const installed = transaction.getInstalledScope(
          mutationFence.effectScopeKey,
        );
        if (installed?.mutationFenceFingerprint !== fingerprint)
          throw new ArtifactMutationAuthorityError(
            "artifact_authority_not_installed",
          );
        for (const candidate of watermarks(
          mutationFence,
          installed.writerIdentity,
        )) {
          const current = transaction.getWatermark(storageKey(candidate));
          if (
            current?.version !== candidate.version ||
            current.identity !== candidate.identity
          )
            throw new ArtifactMutationAuthorityError(
              "artifact_cross_scope_high_watermark_rejected",
            );
        }
        return installed;
      });
    },
  };
  return Object.freeze(authority);
}

export function createDurableArtifactMutationAuthority(
  store: ArtifactMutationAuthorityStore,
): ArtifactMutationAuthority {
  return createArtifactMutationAuthority(store, false);
}

export function createInMemoryArtifactMutationAuthorityTestFake(
  state: InMemoryArtifactMutationAuthorityTestState,
): ArtifactMutationAuthority {
  return createArtifactMutationAuthority(
    createInMemoryArtifactMutationAuthorityStoreTestFake(state),
    true,
  );
}
