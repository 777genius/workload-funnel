import type { MutationFence } from "@workload-funnel/kernel";
import {
  GatewayContractError,
  authorizeHyperQueueMutation,
  compareInstalledSchedulerFence,
  schedulerMutationScopeKey,
  validateMutationRequest,
  verifySchedulerFenceInstallAcknowledgement,
  type AuthorizedHyperQueueMutation,
  type EffectReceiptEvidence,
  type MutateHyperQueueRequest,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import { createEffectReceipt } from "./effect-receipt.js";
import { assertCurrentCrossScopeAuthority } from "./cross-scope-authority.js";
import {
  fingerprint,
  scopeState,
  type GatewayRegistryRuntime,
  type ScopeState,
} from "./gateway-registry-runtime.js";
import { validateInstallAcknowledgement } from "./gateway-installation-schema.js";
import {
  validateRecoveredCliIntent,
  validateRecoveredEffectReceipt,
} from "./effect-operation-recovery.js";
import type {
  OperationState,
  PrepareGatewayMutation,
} from "./effect-operation-state.js";
import type { GatewayWalRecord } from "../domain/gateway-wal-record.js";

export type { PrepareGatewayMutation } from "./effect-operation-state.js";

export class EffectOperationRegistry {
  readonly #operations = new Map<string, OperationState>();

  public constructor(private readonly runtime: GatewayRegistryRuntime) {}

  public unresolvedOperations(): readonly OperationState[] {
    return [...this.#operations.values()].filter(
      (operation) => operation.receipt === undefined,
    );
  }

  public hasUnresolvedInScope(scopeKey: string): boolean {
    return this.unresolvedOperations().some(
      (operation) =>
        schedulerMutationScopeKey(operation.request.scope) === scopeKey,
    );
  }

  public prepareMutation(
    request: MutateHyperQueueRequest,
  ): PrepareGatewayMutation {
    this.runtime.assertHealthy();
    this.validateRequest(request);
    const requestFingerprint = fingerprint(request);
    const prior = this.#operations.get(request.operationId);
    if (prior !== undefined)
      return this.existingResult(prior, requestFingerprint);
    const key = schedulerMutationScopeKey(request.scope);
    const state = scopeState(this.runtime, key);
    const rejection = this.rejectBeforeMutation(request, state, key);
    if (rejection !== undefined) {
      this.runtime.wal.append({
        kind: "cli_intent",
        request,
        requestFingerprint,
      });
      const receipt = createEffectReceipt(
        request,
        rejection.outcome,
        rejection.reason,
        this.runtime.authorityId,
        this.runtime.wal.nextSequence,
      );
      this.#operations.set(request.operationId, {
        receipt,
        request,
        requestFingerprint,
      });
      this.runtime.wal.append({
        kind: "effect_receipt",
        receipt,
        requestFingerprint,
      });
      return { kind: "receipt", receipt };
    }
    const sequence = this.runtime.wal.append({
      kind: "cli_intent",
      request,
      requestFingerprint,
    });
    this.#operations.set(request.operationId, { request, requestFingerprint });
    return {
      authorization: authorizeHyperQueueMutation(request, sequence),
      kind: "authorized",
      requestFingerprint,
    };
  }

  public replayReceipt(
    request: MutateHyperQueueRequest,
  ): EffectReceiptEvidence | undefined {
    this.validateRequest(request);
    const prior = this.#operations.get(request.operationId);
    if (prior === undefined) return undefined;
    if (prior.requestFingerprint !== fingerprint(request))
      throw new GatewayContractError("operation_conflict");
    return prior.receipt;
  }

  public completeMutation(
    authorization: AuthorizedHyperQueueMutation,
    result: Readonly<{
      externalMappingOrInvocationId?: string;
      outcome: "applied" | "rejected" | "superseded" | "unknown";
      reason: string;
    }>,
  ): EffectReceiptEvidence {
    const request = authorization.request;
    const operation = this.#operations.get(request.operationId);
    if (operation === undefined || operation.receipt !== undefined)
      throw new GatewayContractError("operation_conflict", "completion");
    const receipt = createEffectReceipt(
      request,
      result.outcome,
      result.reason,
      this.runtime.authorityId,
      this.runtime.wal.nextSequence,
      result.externalMappingOrInvocationId,
    );
    this.runtime.wal.append({
      kind: "effect_receipt",
      receipt,
      requestFingerprint: operation.requestFingerprint,
    });
    operation.receipt = receipt;
    return receipt;
  }

  public recoverUnresolvedAsUnknown(): readonly EffectReceiptEvidence[] {
    this.runtime.assertHealthy();
    const receipts: EffectReceiptEvidence[] = [];
    for (const operation of this.unresolvedOperations()) {
      const state = scopeState(
        this.runtime,
        schedulerMutationScopeKey(operation.request.scope),
      );
      state.closed = true;
      state.cordonReason = "unresolved_cli_intent";
      const receipt = createEffectReceipt(
        operation.request,
        "unknown",
        "gateway_recovered_unresolved_cli_intent",
        this.runtime.authorityId,
        this.runtime.wal.nextSequence,
      );
      this.runtime.wal.append({
        kind: "effect_receipt",
        receipt,
        requestFingerprint: operation.requestFingerprint,
      });
      operation.receipt = receipt;
      this.runtime.wal.append({
        kind: "scope_cordoned",
        reason: "unresolved_cli_intent",
        scope: operation.request.scope,
      });
      receipts.push(receipt);
    }
    return Object.freeze(receipts);
  }

  public applyRecoveredRecord(
    record: GatewayWalRecord,
    sequence: number,
  ): boolean {
    if (record.kind === "cli_intent") {
      validateRecoveredCliIntent(record.request, record.requestFingerprint);
      if (this.#operations.has(record.request.operationId))
        throw new Error("gateway_cli_intent_operation_collision");
      this.#operations.set(record.request.operationId, {
        request: record.request,
        requestFingerprint: record.requestFingerprint,
      });
    } else if (record.kind === "effect_receipt") {
      const operation = this.#operations.get(record.receipt.operationId);
      if (
        operation?.requestFingerprint !== record.requestFingerprint ||
        operation.receipt !== undefined
      )
        throw new Error("gateway_receipt_without_intent");
      validateRecoveredEffectReceipt(
        record.receipt,
        operation.request,
        this.runtime.authorityId,
        sequence,
      );
      operation.receipt = record.receipt;
    } else if (record.kind === "scope_cordoned") {
      if (record.reason !== "unresolved_cli_intent")
        throw new Error("gateway_scope_cordon_reason_invalid");
      const state = scopeState(
        this.runtime,
        schedulerMutationScopeKey(record.scope),
      );
      state.closed = true;
      state.cordonReason = record.reason;
      state.registrySequence = sequence;
    } else return false;
    return true;
  }

  private existingResult(
    prior: OperationState,
    requestFingerprint: string,
  ): PrepareGatewayMutation {
    if (prior.requestFingerprint !== requestFingerprint)
      throw new GatewayContractError("operation_conflict");
    if (prior.receipt === undefined)
      throw new GatewayContractError("gateway_cordoned", "unresolved_intent");
    return { kind: "receipt", receipt: prior.receipt };
  }

  private validateRequest(request: MutateHyperQueueRequest): void {
    validateMutationRequest(request);
    validateInstallAcknowledgement(
      request.acknowledgedInstall,
      this.runtime.authorityId,
      this.runtime.acknowledgementKey,
    );
    if (request.submitRevocationAcknowledgement !== undefined)
      validateInstallAcknowledgement(
        request.submitRevocationAcknowledgement,
        this.runtime.authorityId,
        this.runtime.acknowledgementKey,
      );
  }

  private rejectBeforeMutation(
    request: MutateHyperQueueRequest,
    state: ScopeState,
    key: string,
  ):
    | Readonly<{ outcome: "rejected" | "superseded"; reason: string }>
    | undefined {
    if (state.fence === undefined || state.fingerprint === undefined)
      throw new GatewayContractError("authority_not_installed");
    let reason: string | undefined;
    let outcome: "rejected" | "superseded" = "rejected";
    const candidateFence: MutationFence = request.mutationFence;
    const comparison = compareInstalledSchedulerFence(
      candidateFence,
      state.fence,
      request.scope,
    );
    if (comparison === "lower") reason = "lower_authority";
    else if (comparison === "equal_version_mismatch")
      reason = "equal_version_mismatch";
    else if (comparison === "dominates")
      reason = "greater_authority_requires_signed_install";
    const crossScopeComparison = assertCurrentCrossScopeAuthority(
      this.runtime,
      candidateFence,
      request.scope,
    );
    if (crossScopeComparison === "lower") reason ??= "lower_authority";
    else if (crossScopeComparison === "equal_version_mismatch")
      reason ??= "equal_version_mismatch";
    else if (crossScopeComparison === "dominates")
      reason ??= "greater_authority_requires_signed_install";
    if (
      !verifySchedulerFenceInstallAcknowledgement(
        request.acknowledgedInstall,
        this.runtime.acknowledgementKey,
      ) ||
      request.acknowledgedInstall.claims.registrySequence !==
        state.acknowledgement?.claims.registrySequence ||
      request.acknowledgedInstall.claims.installedFingerprint !==
        state.fingerprint
    )
      reason ??= "install_acknowledgement_mismatch";
    if (
      (!state.invalidatedByCrossScope && state.closed) ||
      this.runtime.closing.has(key)
    ) {
      reason ??= "gateway_scope_closed";
      outcome = "superseded";
    }
    if (this.runtime.authorityRevalidationRequired()) {
      reason ??= "gateway_startup_revalidation_required";
      outcome = "superseded";
    }
    if (state.cordonReason !== undefined)
      throw new GatewayContractError("gateway_cordoned", state.cordonReason);
    if (request.scope.effectKind === "dispatch_cancel")
      reason ??= this.cancelBarrierRejection(request);
    if (
      candidateFence.notBefore !== undefined &&
      this.runtime.nowMs() < candidateFence.notBefore
    )
      reason ??= "not_yet_valid";
    if (
      candidateFence.notAfter !== undefined &&
      this.runtime.nowMs() >= candidateFence.notAfter
    )
      reason ??= "expired";
    return reason === undefined
      ? undefined
      : Object.freeze({ outcome, reason });
  }

  private cancelBarrierRejection(
    request: MutateHyperQueueRequest,
  ): string | undefined {
    const acknowledgement = request.submitRevocationAcknowledgement;
    if (acknowledgement === undefined)
      return "submit_revocation_acknowledgement_missing";
    const scopeKey = schedulerMutationScopeKey(acknowledgement.claims.scope);
    const state = scopeState(this.runtime, scopeKey);
    if (this.hasUnresolvedInScope(scopeKey))
      return "submit_revocation_unresolved";
    if (
      !state.closed ||
      this.runtime.closing.has(scopeKey) ||
      state.cordonReason !== undefined ||
      state.invalidatedByCrossScope ||
      state.fence === undefined ||
      state.scope === undefined ||
      state.acknowledgement?.claims.registrySequence !==
        acknowledgement.claims.registrySequence ||
      state.fingerprint !== acknowledgement.claims.installedFingerprint ||
      state.fence.issuedStartRevocationRevision !==
        acknowledgement.claims.comparisonFields["issuedStartRevocationRevision"]
    )
      return "submit_revocation_barrier_mismatch";
    if (
      assertCurrentCrossScopeAuthority(
        this.runtime,
        state.fence,
        state.scope,
      ) !== "equal"
    )
      return "submit_revocation_barrier_mismatch";
    return undefined;
  }
}
