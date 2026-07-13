import type { KeyObject } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  verifySealOutputRequest,
  type SealOutputClaims,
  type SealOutputReceipt,
  type SignedSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";

import { SealerWalError } from "./sealer-wal.js";
import type { SealerWal } from "./sealer-wal.js";
import type {
  PinnedFilesystemIdentity,
  SealWalState,
} from "../domain/sealer-wal-record.js";

export interface SealAuthorityInstallAcknowledgement {
  readonly installOperationId: string;
  readonly effectScopeKey: string;
  readonly tupleFingerprint: string;
  readonly mutationFenceFingerprint: string;
  readonly registrySequence: number;
}

export interface SealPreparedEvidence {
  readonly outputParent: PinnedFilesystemIdentity;
  readonly stagingParent: PinnedFilesystemIdentity;
  readonly sourceName: string;
  readonly destinationName: string;
  readonly treeDigest: string;
}

export type SealRegistryErrorCode =
  | "sealer_cordoned"
  | "authority_missing"
  | "authority_conflict"
  | "stale_authority"
  | "seal_state_conflict";

export class SealRegistryError extends Error {
  public constructor(public readonly code: SealRegistryErrorCode) {
    super(code);
    this.name = "SealRegistryError";
  }
}

interface SealState {
  readonly claims: SealOutputClaims;
  readonly evidence: SealPreparedEvidence;
  readonly state: SealWalState;
  readonly receipt?: SealOutputReceipt;
}

export class SealAuthorityRegistry {
  readonly #authorities = new Map<
    string,
    Readonly<{ request: SignedSealOutputRequest; sequence: number }>
  >();
  readonly #installs = new Map<string, SealAuthorityInstallAcknowledgement>();
  readonly #scopes = new Map<string, SealOutputClaims>();
  readonly #states = new Map<string, SealState>();
  #cordoned = false;

  public constructor(
    public readonly wal: SealerWal,
    private readonly trustedKeys: ReadonlyMap<string, KeyObject>,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (wal.cordonReason !== undefined) {
      this.#cordoned = true;
      return;
    }
    try {
      for (const recovered of wal.records) {
        const record = recovered.record;
        if (record.kind === "wal_initialized") {
          continue;
        } else if (record.kind === "authority_installed") {
          const claims = verifySealOutputRequest(
            record.authorization,
            this.trustedKeys,
            Math.min(this.nowMs(), record.authorization.claims.expiresAtMs - 1),
          );
          const current = this.#scopes.get(claims.mutationFence.effectScopeKey);
          if (current !== undefined)
            this.assertMonotonic(
              current.mutationFence,
              claims.mutationFence,
              current.tupleFingerprint,
              claims.tupleFingerprint,
            );
          this.applyAuthority(
            record.installOperationId,
            record.authorization,
            claims,
            recovered.sequence,
            false,
          );
        } else {
          const authority = this.#authorities.get(record.operationId);
          if (
            authority?.request.claims.tupleFingerprint !==
            record.tupleFingerprint
          ) {
            throw new Error("orphan_seal_state");
          }
          this.#states.set(
            record.operationId,
            Object.freeze({
              claims: authority.request.claims,
              evidence: Object.freeze({
                destinationName: record.destinationName,
                outputParent: record.outputParent,
                sourceName: record.sourceName,
                stagingParent: record.stagingParent,
                treeDigest: record.treeDigest,
              }),
              ...(record.receipt === undefined
                ? {}
                : { receipt: record.receipt }),
              state: record.state,
            }),
          );
        }
      }
    } catch {
      this.#cordoned = true;
    }
  }

  public get cordoned(): boolean {
    return this.#cordoned || this.wal.cordonReason !== undefined;
  }

  public install(
    installOperationId: string,
    authorization: SignedSealOutputRequest,
  ): SealAuthorityInstallAcknowledgement {
    this.assertHealthy();
    const claims = verifySealOutputRequest(
      authorization,
      this.trustedKeys,
      this.nowMs(),
    );
    const prior = this.#installs.get(installOperationId);
    if (prior !== undefined) {
      if (prior.tupleFingerprint !== claims.tupleFingerprint)
        throw new SealRegistryError("authority_conflict");
      return prior;
    }
    const current = this.#scopes.get(claims.mutationFence.effectScopeKey);
    if (current !== undefined)
      this.assertMonotonic(
        current.mutationFence,
        claims.mutationFence,
        current.tupleFingerprint,
        claims.tupleFingerprint,
      );
    const operation = this.#authorities.get(claims.operationId);
    if (
      operation !== undefined &&
      operation.request.claims.tupleFingerprint !== claims.tupleFingerprint
    )
      throw new SealRegistryError("authority_conflict");
    const record = this.append({
      authorization,
      installOperationId,
      kind: "authority_installed",
    });
    return this.applyAuthority(
      installOperationId,
      authorization,
      claims,
      record.sequence,
      true,
    );
  }

  public authorize(
    authorization: SignedSealOutputRequest,
  ): Readonly<{ claims: SealOutputClaims; registrySequence: number }> {
    this.assertHealthy();
    const claims = verifySealOutputRequest(
      authorization,
      this.trustedKeys,
      this.nowMs(),
    );
    const installed = this.#authorities.get(claims.operationId);
    if (installed === undefined)
      throw new SealRegistryError("authority_missing");
    if (
      installed.request.claims.tupleFingerprint !== claims.tupleFingerprint ||
      installed.request.signatureBase64Url !== authorization.signatureBase64Url
    )
      throw new SealRegistryError("authority_conflict");
    const current = this.#scopes.get(claims.mutationFence.effectScopeKey);
    if (
      current?.operationId !== claims.operationId ||
      current.tupleFingerprint !== claims.tupleFingerprint ||
      fingerprintMutationFence(current.mutationFence) !==
        fingerprintMutationFence(claims.mutationFence)
    )
      throw new SealRegistryError("stale_authority");
    return Object.freeze({ claims, registrySequence: installed.sequence });
  }

  public state(operationId: string): SealState | undefined {
    return this.#states.get(operationId);
  }

  public receiptInventory(): readonly Readonly<{
    sequence: number;
    receipt: SealOutputReceipt;
  }>[] {
    const sequenceByOperation = new Map<string, number>();
    for (const recovered of this.wal.records) {
      if (
        recovered.record.kind === "seal_state" &&
        recovered.record.state === "receipt_persisted"
      ) {
        sequenceByOperation.set(
          recovered.record.operationId,
          recovered.sequence,
        );
      }
    }
    return [...this.#states.values()]
      .filter(
        (state): state is SealState & { readonly receipt: SealOutputReceipt } =>
          state.receipt !== undefined,
      )
      .map((state) =>
        Object.freeze({
          receipt: state.receipt,
          sequence: sequenceByOperation.get(state.claims.operationId) ?? 0,
        }),
      )
      .sort((left, right) => left.sequence - right.sequence);
  }

  public transition(
    claims: SealOutputClaims,
    state: SealWalState,
    evidence: SealPreparedEvidence,
    receipt?: SealOutputReceipt,
  ): SealState {
    this.assertHealthy();
    const prior = this.#states.get(claims.operationId);
    const order: readonly SealWalState[] = [
      "prepared",
      "seal_call_issued",
      "sealed_or_unknown",
      "receipt_persisted",
    ];
    const expectedIndex =
      prior === undefined ? 0 : order.indexOf(prior.state) + 1;
    if (
      state !== order[expectedIndex] ||
      (prior !== undefined &&
        JSON.stringify(prior.evidence) !== JSON.stringify(evidence))
    ) {
      throw new SealRegistryError("seal_state_conflict");
    }
    if ((state === "receipt_persisted") !== (receipt !== undefined))
      throw new SealRegistryError("seal_state_conflict");
    this.append({
      destinationName: evidence.destinationName,
      kind: "seal_state",
      mutationFence: claims.mutationFence,
      mutationFenceFingerprint: fingerprintMutationFence(claims.mutationFence),
      operationId: claims.operationId,
      outputParent: evidence.outputParent,
      ...(receipt === undefined ? {} : { receipt }),
      sourceName: evidence.sourceName,
      stagingParent: evidence.stagingParent,
      state,
      treeDigest: evidence.treeDigest,
      tupleFingerprint: claims.tupleFingerprint,
    });
    const next = Object.freeze({
      claims,
      evidence,
      ...(receipt === undefined ? {} : { receipt }),
      state,
    });
    this.#states.set(claims.operationId, next);
    return next;
  }

  private applyAuthority(
    installOperationId: string,
    request: SignedSealOutputRequest,
    claims: SealOutputClaims,
    sequence: number,
    enforceCollision: boolean,
  ): SealAuthorityInstallAcknowledgement {
    const existing = this.#authorities.get(claims.operationId);
    if (
      enforceCollision &&
      existing !== undefined &&
      existing.request.claims.tupleFingerprint !== claims.tupleFingerprint
    ) {
      throw new SealRegistryError("authority_conflict");
    }
    const acknowledgement = Object.freeze({
      effectScopeKey: claims.mutationFence.effectScopeKey,
      installOperationId,
      mutationFenceFingerprint: fingerprintMutationFence(claims.mutationFence),
      registrySequence: sequence,
      tupleFingerprint: claims.tupleFingerprint,
    });
    this.#authorities.set(
      claims.operationId,
      Object.freeze({ request, sequence }),
    );
    this.#installs.set(installOperationId, acknowledgement);
    this.#scopes.set(claims.mutationFence.effectScopeKey, claims);
    return acknowledgement;
  }

  private assertMonotonic(
    current: MutationFence,
    next: MutationFence,
    currentTuple: string,
    nextTuple: string,
  ): void {
    if (
      next.clusterIncarnationVersion < current.clusterIncarnationVersion ||
      next.namespaceWriterEpoch < current.namespaceWriterEpoch ||
      (current.ownerFence !== undefined &&
        (next.ownerFence ?? -1) < current.ownerFence) ||
      next.operationGateRevision < current.operationGateRevision ||
      next.expectedDesiredVersion < current.expectedDesiredVersion
    )
      throw new SealRegistryError("stale_authority");
    if (
      (next.clusterIncarnationVersion === current.clusterIncarnationVersion &&
        next.clusterIncarnation !== current.clusterIncarnation) ||
      (next.namespaceWriterEpoch === current.namespaceWriterEpoch &&
        next.namespaceId !== current.namespaceId) ||
      next.attemptId !== current.attemptId ||
      next.executionGeneration !== current.executionGeneration ||
      next.allocationId !== current.allocationId ||
      (next.operationGateRevision === current.operationGateRevision &&
        next.requiredGate !== current.requiredGate) ||
      next.effectScopeKey !== current.effectScopeKey ||
      (next.nodeBootEpoch === current.nodeBootEpoch &&
        next.nodeId !== current.nodeId)
    )
      throw new SealRegistryError("authority_conflict");
    if (
      next.expectedDesiredVersion === current.expectedDesiredVersion &&
      (next.desiredEffect !== current.desiredEffect ||
        next.supersessionKey !== current.supersessionKey)
    )
      throw new SealRegistryError("authority_conflict");
    const everyVersionEqual =
      next.clusterIncarnationVersion === current.clusterIncarnationVersion &&
      next.namespaceWriterEpoch === current.namespaceWriterEpoch &&
      next.ownerFence === current.ownerFence &&
      next.operationGateRevision === current.operationGateRevision &&
      next.expectedDesiredVersion === current.expectedDesiredVersion &&
      next.nodeBootEpoch === current.nodeBootEpoch;
    if (everyVersionEqual && nextTuple !== currentTuple) {
      throw new SealRegistryError("authority_conflict");
    }
  }

  private append(
    record: Parameters<SealerWal["append"]>[0],
  ): ReturnType<SealerWal["append"]> {
    try {
      return this.wal.append(record);
    } catch (error) {
      if (error instanceof SealerWalError)
        throw new SealRegistryError("sealer_cordoned");
      throw error;
    }
  }

  private assertHealthy(): void {
    if (this.cordoned) throw new SealRegistryError("sealer_cordoned");
  }
}
