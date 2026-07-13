import type { MutationFence } from "@workload-funnel/kernel";
import {
  GatewayContractError,
  SCHEDULER_GATEWAY_PROTOCOL,
  compareInstalledSchedulerFence,
  compareSchedulerFenceToHighWatermarks,
  mutationFenceComparisonFields,
  schedulerAuthoritySerializationKeys,
  schedulerMutationScopeKey,
  signSchedulerFenceInstallAcknowledgement,
  type SchedulerFenceInstallAcknowledgementClaims,
  type SchedulerScopeCloseAcknowledgement,
  type SchedulerScopeCloseRequest,
  type SchedulerScopeReopenRequest,
  type SignedSchedulerFenceInstall,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import {
  applyRecoveredInstallationRecord,
  type InstallationRecoveryState,
} from "./gateway-installation-recovery.js";
import {
  snapshotCloseRequest,
  snapshotInstallRequest,
  snapshotReopenRequest,
  validateCloseRequest,
  validateInstallRequest,
  validateReopenRequest,
} from "./gateway-installation-schema.js";
import {
  applyCrossScopeInstall,
  assertCurrentCrossScopeAuthority,
  combineAuthorityComparisons,
  planCrossScopeInstall,
} from "./cross-scope-authority.js";
import {
  fingerprint,
  runSerialized,
  scopeState,
  type DurableOperationResult,
  type GatewayRegistryRuntime,
} from "./gateway-registry-runtime.js";
import type { GatewayWalRecord } from "../domain/gateway-wal-record.js";

export class FenceInstallationRegistry {
  readonly #installReceipts = new Map<
    string,
    DurableOperationResult<SignedSchedulerFenceInstallAcknowledgement>
  >();
  readonly #closeReceipts = new Map<
    string,
    DurableOperationResult<SchedulerScopeCloseAcknowledgement>
  >();
  readonly #reopenOperations = new Map<string, string>();

  public constructor(
    private readonly runtime: GatewayRegistryRuntime,
    private readonly hasUnresolvedEffect: (scopeKey: string) => boolean,
  ) {}

  public async closeAndDrain(
    request: SchedulerScopeCloseRequest,
  ): Promise<SchedulerScopeCloseAcknowledgement> {
    request = snapshotCloseRequest(request);
    this.runtime.assertHealthy();
    validateCloseRequest(request, this.runtime.authorityId);
    const requestFingerprint = fingerprint(request);
    const existing = this.#closeReceipts.get(request.closeOperationId);
    if (existing !== undefined)
      return this.exactResult(existing, requestFingerprint, "close");
    const key = schedulerMutationScopeKey(request.scope);
    this.runtime.closing.add(key);
    const invalidatedQueueCount = this.runtime.serializer.queued(key);
    return this.runtime.serializer.run(key, () => {
      const serializedExisting = this.#closeReceipts.get(
        request.closeOperationId,
      );
      if (serializedExisting !== undefined)
        return this.exactResult(
          serializedExisting,
          requestFingerprint,
          "close",
        );
      const unresolved = this.hasUnresolvedEffect(key);
      const acknowledgement: SchedulerScopeCloseAcknowledgement = Object.freeze(
        {
          closeOperationId: request.closeOperationId,
          disposition: unresolved ? "unresolved" : "drained",
          invalidatedQueueCount,
          registrySequence: this.runtime.wal.nextSequence,
          scope: request.scope,
        },
      );
      this.runtime.wal.append({
        acknowledgement,
        kind: "close",
        requestFingerprint,
      });
      this.#closeReceipts.set(request.closeOperationId, {
        requestFingerprint,
        result: acknowledgement,
      });
      const state = scopeState(this.runtime, key);
      state.closed = true;
      if (unresolved) state.cordonReason = "unresolved_cli_intent";
      state.registrySequence = acknowledgement.registrySequence;
      this.runtime.closing.delete(key);
      return acknowledgement;
    });
  }

  public async install(
    request: SignedSchedulerFenceInstall,
  ): Promise<SignedSchedulerFenceInstallAcknowledgement> {
    request = snapshotInstallRequest(request);
    this.runtime.assertHealthy();
    const requestFingerprint = fingerprint(request);
    const existing = this.#installReceipts.get(
      request.claims.installOperationId,
    );
    if (existing !== undefined)
      return this.exactResult(existing, requestFingerprint, "install");
    validateInstallRequest(request, {
      authorityId: this.runtime.authorityId,
      nowMs: this.runtime.nowMs(),
      trustedInstallKeys: this.runtime.trustedInstallKeys,
    });
    const claims = request.claims;
    const candidateFence: MutationFence = claims.mutationFence;
    const scopeKey = schedulerMutationScopeKey(claims.scope);
    return runSerialized(
      this.runtime,
      schedulerAuthoritySerializationKeys(candidateFence, claims.scope),
      () => {
        const serializedExisting = this.#installReceipts.get(
          claims.installOperationId,
        );
        if (serializedExisting !== undefined)
          return this.exactResult(
            serializedExisting,
            requestFingerprint,
            "install",
          );
        const state = scopeState(this.runtime, scopeKey);
        if (!state.closed || this.runtime.closing.has(scopeKey))
          throw new GatewayContractError(
            "gateway_scope_closed",
            "close_required",
          );
        const crossScopeBefore = compareSchedulerFenceToHighWatermarks(
          this.runtime.highWatermarks,
          candidateFence,
          claims.scope,
        );
        if (state.fence !== undefined && crossScopeBefore === "missing")
          throw new GatewayContractError(
            "gateway_cordoned",
            "cross_scope_authority_missing",
          );
        const highWatermarkPlan = planCrossScopeInstall(
          this.runtime,
          candidateFence,
          claims.scope,
        );
        let comparisonResult = combineAuthorityComparisons(
          compareInstalledSchedulerFence(
            candidateFence,
            state.fence,
            claims.scope,
          ),
          highWatermarkPlan.comparison,
        );
        if (claims.expectedPriorFingerprint !== (state.fingerprint ?? null))
          comparisonResult = "equal_version_mismatch";
        const unresolved = this.hasUnresolvedEffect(scopeKey);
        const result =
          comparisonResult === "dominates"
            ? "installed"
            : comparisonResult === "equal"
              ? "already_installed"
              : "rejected";
        const acknowledgementClaims: SchedulerFenceInstallAcknowledgementClaims =
          Object.freeze({
            authorityId: this.runtime.authorityId,
            comparisonFields: mutationFenceComparisonFields(candidateFence),
            comparisonResult,
            drainDisposition: unresolved ? "unresolved" : "drained",
            installOperationId: claims.installOperationId,
            installedFingerprint:
              result === "rejected"
                ? (state.fingerprint ?? claims.mutationFenceFingerprint)
                : claims.mutationFenceFingerprint,
            invalidatedQueueCount: 0,
            protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
            registrySequence: this.runtime.wal.nextSequence,
            result,
            scope: claims.scope,
          });
        const acknowledgement = signSchedulerFenceInstallAcknowledgement(
          acknowledgementClaims,
          this.runtime.acknowledgementKey,
        );
        this.runtime.wal.append({
          acknowledgement,
          authorityHighWatermarks:
            result === "rejected" ? [] : highWatermarkPlan.records,
          fence: candidateFence,
          kind: "install",
          mutationFenceFingerprint: claims.mutationFenceFingerprint,
          requestFingerprint,
        });
        this.#installReceipts.set(claims.installOperationId, {
          requestFingerprint,
          result: acknowledgement,
        });
        if (result !== "rejected") {
          applyCrossScopeInstall(this.runtime, highWatermarkPlan, scopeKey);
          state.acknowledgement = acknowledgement;
          if (!unresolved) {
            delete state.cordonReason;
            state.startupRevalidationRequired = false;
          }
          state.fence = candidateFence;
          state.fingerprint = claims.mutationFenceFingerprint;
          state.invalidatedByCrossScope = false;
          state.registrySequence = acknowledgementClaims.registrySequence;
          state.scope = claims.scope;
        }
        return acknowledgement;
      },
    );
  }

  public async reopen(request: SchedulerScopeReopenRequest): Promise<void> {
    request = snapshotReopenRequest(request);
    this.runtime.assertHealthy();
    validateReopenRequest(
      request,
      this.runtime.authorityId,
      this.runtime.acknowledgementKey,
    );
    const claims = request.acknowledgement.claims;
    const key = schedulerMutationScopeKey(claims.scope);
    const requestFingerprint = fingerprint(request);
    const existing = this.#reopenOperations.get(request.reopenOperationId);
    if (existing !== undefined) {
      this.assertExact(existing, requestFingerprint, "reopen");
      return;
    }
    const priorState = scopeState(this.runtime, key);
    const keys =
      priorState.fence === undefined
        ? [key]
        : schedulerAuthoritySerializationKeys(priorState.fence, claims.scope);
    await runSerialized(this.runtime, keys, () => {
      const serializedExisting = this.#reopenOperations.get(
        request.reopenOperationId,
      );
      if (serializedExisting !== undefined) {
        this.assertExact(serializedExisting, requestFingerprint, "reopen");
        return;
      }
      const state = scopeState(this.runtime, key);
      if (
        (claims.result !== "installed" &&
          claims.result !== "already_installed") ||
        state.startupRevalidationRequired ||
        state.invalidatedByCrossScope ||
        state.cordonReason !== undefined ||
        state.fingerprint !== claims.installedFingerprint ||
        state.registrySequence !== claims.registrySequence
      )
        throw new GatewayContractError("invalid_gateway_request", "reopen_ack");
      if (
        state.fence === undefined ||
        assertCurrentCrossScopeAuthority(
          this.runtime,
          state.fence,
          claims.scope,
        ) !== "equal"
      )
        throw new GatewayContractError("invalid_gateway_request", "reopen_ack");
      this.runtime.wal.append({
        installAcknowledgement: request.acknowledgement,
        kind: "reopen",
        reopenOperationId: request.reopenOperationId,
        requestFingerprint,
      });
      this.#reopenOperations.set(request.reopenOperationId, requestFingerprint);
      state.closed = false;
      state.registrySequence = this.runtime.wal.nextSequence - 1;
    });
  }

  public applyRecoveredRecord(
    record: GatewayWalRecord,
    sequence: number,
  ): boolean {
    const recovered: InstallationRecoveryState = {
      closeReceipts: this.#closeReceipts,
      installReceipts: this.#installReceipts,
      reopenOperations: this.#reopenOperations,
    };
    return applyRecoveredInstallationRecord(
      record,
      sequence,
      this.runtime,
      recovered,
    );
  }

  private exactResult<T>(
    existing: DurableOperationResult<T>,
    requestFingerprint: string,
    kind: string,
  ): T {
    this.assertExact(existing.requestFingerprint, requestFingerprint, kind);
    return existing.result;
  }

  private assertExact(actual: string, expected: string, kind: string): void {
    if (actual !== expected)
      throw new GatewayContractError("operation_conflict", kind);
  }
}
