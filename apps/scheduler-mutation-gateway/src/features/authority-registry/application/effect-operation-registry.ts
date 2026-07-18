import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  GatewayContractError,
  authorizeHyperQueueMutation,
  compareInstalledSchedulerFence,
  schedulerMutationScopeKey,
  validateMutationRequest,
  verifySchedulerFenceInstallAcknowledgement,
  type AuthorizedHyperQueueMutation,
  type EffectReceiptEvidence,
  type HyperQueueDispatchMapping,
  type MutateHyperQueueRequest,
  canonicalHyperQueueOperationJobName,
  HYPERQUEUE_ADAPTER_CONTRACT_VERSION,
  HYPERQUEUE_ADAPTER_KEY,
  validateCanonicalHyperQueueOperationJobName,
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
  readonly #mappingOperationByJobName = new Map<string, string>();
  readonly #mappingOperationByReference = new Map<string, string>();
  readonly #operations = new Map<string, OperationState>();

  public constructor(private readonly runtime: GatewayRegistryRuntime) {}

  public unresolvedOperations(): readonly OperationState[] {
    return [...this.#operations.values()].filter(
      (operation) => operation.receipt === undefined,
    );
  }

  public unresolvedAuthorizations(): readonly AuthorizedHyperQueueMutation[] {
    return Object.freeze(
      this.unresolvedOperations().map((operation) =>
        authorizeHyperQueueMutation(
          operation.request,
          operation.intentRegistrySequence,
          operation.requestFingerprint,
          operation.canonicalJobName,
        ),
      ),
    );
  }

  public reconciliationRequiredOperationIds(): readonly string[] {
    return Object.freeze(
      [...this.#operations.values()]
        .filter(
          (operation) =>
            operation.receipt === undefined ||
            operation.receipt.outcome === "unknown",
        )
        .map((operation) => operation.request.operationId),
    );
  }

  public dispatchMapping(
    operationId: string,
  ): HyperQueueDispatchMapping | undefined {
    return this.#operations.get(operationId)?.mapping;
  }

  public hasUnresolvedInScope(scopeKey: string): boolean {
    return [...this.#operations.values()].some(
      (operation) =>
        schedulerMutationScopeKey(operation.request.scope) === scopeKey &&
        (operation.receipt === undefined ||
          operation.receipt.outcome === "unknown"),
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
    this.runtime.wal.assertAppendCapacity(
      request.payload.kind === "submit" ? 3 : 2,
    );
    const canonicalJobName = this.canonicalJobName(request, requestFingerprint);
    this.assertNoCanonicalJobNameCollision(
      canonicalJobName,
      request.operationId,
    );
    const state = scopeState(this.runtime, key);
    const rejection = this.rejectBeforeMutation(request, state, key);
    if (rejection !== undefined) {
      const sequence = this.runtime.wal.append({
        canonicalJobName: canonicalJobName ?? null,
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
        ...(canonicalJobName === undefined ? {} : { canonicalJobName }),
        intentRegistrySequence: sequence,
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
      canonicalJobName: canonicalJobName ?? null,
      kind: "cli_intent",
      request,
      requestFingerprint,
    });
    this.#operations.set(request.operationId, {
      ...(canonicalJobName === undefined ? {} : { canonicalJobName }),
      intentRegistrySequence: sequence,
      request,
      requestFingerprint,
    });
    return {
      authorization: authorizeHyperQueueMutation(
        request,
        sequence,
        requestFingerprint,
        canonicalJobName,
      ),
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
    if (
      request.payload.kind === "submit" &&
      result.outcome === "applied" &&
      operation.mapping === undefined
    )
      throw new GatewayContractError(
        "operation_conflict",
        "dispatch_mapping_missing",
      );
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

  public persistDispatchMapping(
    authorization: AuthorizedHyperQueueMutation,
    result: Readonly<{
      readonly canonicalJobName: string;
      readonly jobId: string;
      readonly taskId: "0";
    }>,
  ): HyperQueueDispatchMapping {
    const request = authorization.request;
    const operation = this.#operations.get(request.operationId);
    if (
      request.payload.kind !== "submit" ||
      operation === undefined ||
      operation.receipt !== undefined ||
      authorization.registrySequence !== operation.intentRegistrySequence ||
      authorization.canonicalJobName !== operation.canonicalJobName
    )
      throw new GatewayContractError(
        "operation_conflict",
        "dispatch_mapping_authority",
      );
    validateMutationRequest(request);
    validateCanonicalHyperQueueOperationJobName(
      {
        mappingFingerprint: request.payload.mappingFingerprint,
        mutationFenceFingerprint: request.mutationFenceFingerprint,
        operationId: request.operationId,
        requestFingerprint: operation.requestFingerprint,
        schedulerInstanceId: request.scope.schedulerInstanceId,
      },
      result.canonicalJobName,
    );
    if (
      operation.requestFingerprint !== fingerprint(request) ||
      request.mutationFenceFingerprint !==
        fingerprintMutationFence(request.mutationFence) ||
      !/^(?:0|[1-9]\d*)$/u.test(result.jobId) ||
      !Number.isSafeInteger(Number(result.jobId))
    )
      throw new GatewayContractError(
        "operation_conflict",
        "dispatch_mapping_validation",
      );
    const mapping = Object.freeze<HyperQueueDispatchMapping>({
      adapterContractVersion: HYPERQUEUE_ADAPTER_CONTRACT_VERSION,
      adapterKey: HYPERQUEUE_ADAPTER_KEY,
      adapterReference: `hq://${result.jobId}`,
      canonicalJobName: result.canonicalJobName,
      dispatchId: request.payload.dispatchId,
      jobId: result.jobId,
      mappingFingerprint: request.payload.mappingFingerprint,
      mutationFenceFingerprint: request.mutationFenceFingerprint,
      operationId: request.operationId,
      requestFingerprint: operation.requestFingerprint,
      schedulerInstanceId: request.scope.schedulerInstanceId,
      taskId: "0",
    });
    if (operation.mapping !== undefined) {
      if (fingerprint(operation.mapping) !== fingerprint(mapping))
        throw new GatewayContractError(
          "operation_conflict",
          "dispatch_mapping_create_only",
        );
      return operation.mapping;
    }
    this.assertMappingIndexes(mapping);
    this.runtime.wal.append({
      kind: "dispatch_mapping",
      mapping,
      requestFingerprint: operation.requestFingerprint,
    });
    operation.mapping = mapping;
    this.indexMapping(mapping);
    return mapping;
  }

  public completeUnknownAndCordon(
    authorization: AuthorizedHyperQueueMutation,
    reason: string,
  ): EffectReceiptEvidence {
    return this.completeAndCordon(authorization, "unknown", reason);
  }

  public completeRejectedAndCordon(
    authorization: AuthorizedHyperQueueMutation,
    reason: string,
  ): EffectReceiptEvidence {
    return this.completeAndCordon(authorization, "rejected", reason);
  }

  private completeAndCordon(
    authorization: AuthorizedHyperQueueMutation,
    outcome: "rejected" | "unknown",
    reason: string,
  ): EffectReceiptEvidence {
    if (!/^[a-z0-9_]{1,128}$/u.test(reason))
      throw new GatewayContractError("operation_conflict", "cordon_reason");
    const request = authorization.request;
    const state = scopeState(
      this.runtime,
      schedulerMutationScopeKey(request.scope),
    );
    this.runtime.wal.append({
      kind: "scope_cordoned",
      reason,
      scope: request.scope,
    });
    state.closed = true;
    state.cordonReason = reason;
    return this.completeMutation(authorization, {
      outcome,
      reason,
    });
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
        ...(record.canonicalJobName === null
          ? {}
          : { canonicalJobName: record.canonicalJobName }),
        intentRegistrySequence: sequence,
        request: record.request,
        requestFingerprint: record.requestFingerprint,
      });
      const expectedJobName = this.canonicalJobName(
        record.request,
        record.requestFingerprint,
      );
      if (expectedJobName !== (record.canonicalJobName ?? undefined))
        throw new Error("gateway_cli_intent_job_name_mismatch");
      this.assertNoCanonicalJobNameCollision(
        expectedJobName,
        record.request.operationId,
      );
    } else if (record.kind === "dispatch_mapping") {
      this.recoverDispatchMapping(record.mapping, record.requestFingerprint);
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
      if (
        operation.request.payload.kind === "submit" &&
        record.receipt.outcome === "applied" &&
        operation.mapping === undefined
      )
        throw new Error("gateway_receipt_without_dispatch_mapping");
      operation.receipt = record.receipt;
    } else if (record.kind === "scope_cordoned") {
      if (!/^[a-z0-9_]{1,128}$/u.test(record.reason))
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

  private canonicalJobName(
    request: MutateHyperQueueRequest,
    requestFingerprint: string,
  ): string | undefined {
    return request.payload.kind === "submit"
      ? canonicalHyperQueueOperationJobName({
          mappingFingerprint: request.payload.mappingFingerprint,
          mutationFenceFingerprint: request.mutationFenceFingerprint,
          operationId: request.operationId,
          requestFingerprint,
          schedulerInstanceId: request.scope.schedulerInstanceId,
        })
      : undefined;
  }

  private assertNoCanonicalJobNameCollision(
    jobName: string | undefined,
    operationId: string,
  ): void {
    if (jobName === undefined) return;
    const prior = this.#mappingOperationByJobName.get(jobName);
    if (prior !== undefined && prior !== operationId)
      throw new GatewayContractError(
        "operation_conflict",
        "canonical_job_name_collision",
      );
    this.#mappingOperationByJobName.set(jobName, operationId);
  }

  private assertMappingIndexes(mapping: HyperQueueDispatchMapping): void {
    const nameOperation = this.#mappingOperationByJobName.get(
      mapping.canonicalJobName,
    );
    const referenceOperation = this.#mappingOperationByReference.get(
      mapping.adapterReference,
    );
    if (
      (nameOperation !== undefined && nameOperation !== mapping.operationId) ||
      (referenceOperation !== undefined &&
        referenceOperation !== mapping.operationId)
    )
      throw new GatewayContractError(
        "operation_conflict",
        "dispatch_mapping_conflict",
      );
  }

  private indexMapping(mapping: HyperQueueDispatchMapping): void {
    this.#mappingOperationByJobName.set(
      mapping.canonicalJobName,
      mapping.operationId,
    );
    this.#mappingOperationByReference.set(
      mapping.adapterReference,
      mapping.operationId,
    );
  }

  private recoverDispatchMapping(
    mapping: HyperQueueDispatchMapping,
    requestFingerprint: string,
  ): void {
    const operation = this.#operations.get(mapping.operationId);
    const recoveredAdapterIdentity: Readonly<{
      adapterContractVersion: unknown;
      adapterKey: unknown;
      taskId: unknown;
    }> = mapping;
    if (
      Object.keys(mapping).sort().join() !==
        [
          "adapterContractVersion",
          "adapterKey",
          "adapterReference",
          "canonicalJobName",
          "dispatchId",
          "jobId",
          "mappingFingerprint",
          "mutationFenceFingerprint",
          "operationId",
          "requestFingerprint",
          "schedulerInstanceId",
          "taskId",
        ]
          .sort()
          .join() ||
      operation === undefined ||
      operation.mapping !== undefined ||
      operation.receipt !== undefined ||
      operation.request.payload.kind !== "submit" ||
      operation.requestFingerprint !== requestFingerprint ||
      mapping.requestFingerprint !== requestFingerprint ||
      mapping.dispatchId !== operation.request.payload.dispatchId ||
      mapping.mappingFingerprint !==
        operation.request.payload.mappingFingerprint ||
      mapping.mutationFenceFingerprint !==
        operation.request.mutationFenceFingerprint ||
      mapping.schedulerInstanceId !==
        operation.request.scope.schedulerInstanceId ||
      mapping.canonicalJobName !== operation.canonicalJobName ||
      recoveredAdapterIdentity.adapterKey !== HYPERQUEUE_ADAPTER_KEY ||
      recoveredAdapterIdentity.adapterContractVersion !==
        HYPERQUEUE_ADAPTER_CONTRACT_VERSION ||
      mapping.adapterReference !== `hq://${mapping.jobId}` ||
      recoveredAdapterIdentity.taskId !== "0" ||
      !/^(?:0|[1-9]\d*)$/u.test(mapping.jobId) ||
      !Number.isSafeInteger(Number(mapping.jobId))
    )
      throw new Error("gateway_dispatch_mapping_recovery_mismatch");
    validateCanonicalHyperQueueOperationJobName(
      {
        mappingFingerprint: mapping.mappingFingerprint,
        mutationFenceFingerprint: mapping.mutationFenceFingerprint,
        operationId: mapping.operationId,
        requestFingerprint: mapping.requestFingerprint,
        schedulerInstanceId: mapping.schedulerInstanceId,
      },
      mapping.canonicalJobName,
    );
    this.assertMappingIndexes(mapping);
    operation.mapping = mapping;
    this.indexMapping(mapping);
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
