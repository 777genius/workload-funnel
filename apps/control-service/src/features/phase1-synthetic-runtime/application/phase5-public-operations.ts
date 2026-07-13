import { createHash } from "node:crypto";

import { createPostgresAuditLedgerStore } from "@workload-funnel/store-postgres/audit-ledger-persistence";
import { createSqliteAuditLedgerStore } from "@workload-funnel/store-sqlite/audit-ledger-persistence";
import type {
  PublicConsumerLimits,
  PublicStreamClass,
} from "@workload-funnel/workload-control/control-event-delivery";
import type { WorkloadStatus } from "@workload-funnel/workload-control/workload-lifecycle";
import { assertGateOpen } from "@workload-funnel/workload-control/operation-gating";

import type {
  EventRegistrationInput,
  Phase5SyntheticPublicOperations,
  RequestContext,
} from "./phase5-public-contracts.js";
import type {
  SyntheticDatabase,
  SyntheticPhase5Operation,
} from "./synthetic-state.js";
import type { Phase1SyntheticService } from "./synthetic-relational-profile.js";
import {
  replaySyntheticErasureLedger,
  syntheticErasureSubjectDigest,
} from "./synthetic-erasure-ledger.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSyntheticScope(context: RequestContext): void {
  if (
    context.effectiveTenantId !== "synthetic-tenant" ||
    context.principalId !== "synthetic-principal"
  )
    throw new Error("not_found");
}

function belongsToTenant(
  database: SyntheticDatabase,
  status: WorkloadStatus | undefined,
  tenantId: string,
): status is WorkloadStatus {
  return (
    status?.workload.tenantId === tenantId &&
    database.state.workloadById.has(status.workload.workloadId)
  );
}

export function createPhase5SyntheticPublicOperations(
  service: Phase1SyntheticService,
  database: SyntheticDatabase,
  clock: () => number,
): Phase5SyntheticPublicOperations {
  const { state } = database;
  replaySyntheticErasureLedger(service, database);
  const audit =
    database.profile === "postgres"
      ? createPostgresAuditLedgerStore(state.audit)
      : createSqliteAuditLedgerStore(state.audit);

  function publicOperationId(canonicalOperationId: string): string {
    const existing =
      state.phase5PublicOperationByCanonicalId.get(canonicalOperationId);
    if (existing !== undefined) return existing;
    const publicId = `op-${digest(canonicalOperationId)}`;
    const collision = state.phase5CanonicalOperationByPublicId.get(publicId);
    if (collision !== undefined && collision !== canonicalOperationId)
      throw new Error("public_operation_id_conflict");
    state.phase5CanonicalOperationByPublicId.set(
      publicId,
      canonicalOperationId,
    );
    state.phase5PublicOperationByCanonicalId.set(
      canonicalOperationId,
      publicId,
    );
    return publicId;
  }

  function emit(
    eventId: string,
    eventType: string,
    context: RequestContext &
      Readonly<{ correlationId?: string; causationId?: string }>,
    aggregateId: string,
    payload: Readonly<Record<string, unknown>>,
    options: Readonly<{
      aggregateVersion?: number;
      streamClass?: PublicStreamClass;
    }> = {},
  ): void {
    if (state.publicEventIds.has(eventId)) return;
    state.publicEventFeed.append({
      aggregateId,
      aggregateVersion: options.aggregateVersion ?? 1,
      causationId: context.causationId ?? eventId,
      correlationId: context.correlationId ?? eventId,
      eventId,
      eventOrdinal: 0,
      eventType,
      occurredAt: clock(),
      partition: "control-1",
      payload,
      streamClass: options.streamClass ?? "general",
      tenantId: context.effectiveTenantId,
    });
    state.publicEventIds.add(eventId);
  }

  function status(
    context: RequestContext,
    runId: string,
  ): WorkloadStatus | undefined {
    assertSyntheticScope(context);
    const found = service.status(runId);
    return belongsToTenant(database, found, context.effectiveTenantId)
      ? found
      : undefined;
  }

  function manifestBelongs(
    context: RequestContext,
    resultManifestId: string,
  ): boolean {
    const manifest = state.manifests.get(resultManifestId);
    if (manifest === undefined) return false;
    const attempt = state.attemptById.get(manifest.attemptId);
    const run =
      attempt === undefined ? undefined : state.runById.get(attempt.runId);
    const workload =
      run === undefined ? undefined : state.workloadById.get(run.workloadId);
    return workload?.tenantId === context.effectiveTenantId;
  }

  function operationKey(
    context: RequestContext,
    kind: string,
    idempotencyKey: string,
  ): string {
    return `${context.effectiveTenantId}:${context.principalId}:${kind}:${idempotencyKey}`;
  }

  function pseudonymizeReferences(value: string): string {
    let result = value;
    for (const [subject, pseudonym] of state.erasedSubjectPseudonyms)
      result = result.replaceAll(subject, pseudonym);
    return result;
  }

  function priorOperation(
    key: string,
    requestDigest: string,
  ):
    | (SyntheticPhase5Operation &
        Readonly<{ contractVersion: "workload-funnel.audited-operation/v1" }>)
    | undefined {
    const prior = state.phase5OperationByKey.get(key);
    if (prior === undefined) return undefined;
    if (state.phase5OperationDigestByKey.get(key) !== requestDigest)
      throw new Error("idempotency_key_conflict");
    return Object.freeze({
      ...prior,
      contractVersion: "workload-funnel.audited-operation/v1",
      duplicate: true,
    });
  }

  function recordOperation(input: {
    readonly key: string;
    readonly requestDigest: string;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly state: SyntheticPhase5Operation["state"];
    readonly context: RequestContext;
    readonly action: string;
    readonly reason: string;
    readonly correlationId: string;
    readonly affectedResources: readonly string[];
    readonly previousState?: string;
    readonly nextState?: string;
  }): SyntheticPhase5Operation &
    Readonly<{ contractVersion: "workload-funnel.audited-operation/v1" }> {
    const auditRecord = audit.append(
      input.operationId,
      pseudonymizeReferences(input.context.principalId),
      input.action,
      pseudonymizeReferences(
        input.affectedResources.at(-1) ?? input.context.effectiveTenantId,
      ),
      {
        affectedResources: Object.freeze([
          input.context.effectiveTenantId,
          ...input.affectedResources.map(pseudonymizeReferences),
        ]),
        correlationId: pseudonymizeReferences(input.correlationId),
        occurredAt: clock(),
        policyVersion: input.context.authorizationPolicyVersion,
        reason: pseudonymizeReferences(input.reason),
        ...(input.nextState === undefined
          ? {}
          : { nextState: input.nextState }),
        ...(input.previousState === undefined
          ? {}
          : { previousState: input.previousState }),
      },
    );
    const receipt: SyntheticPhase5Operation = Object.freeze({
      auditId: auditRecord.auditId,
      duplicate: false,
      idempotencyKey: input.idempotencyKey,
      operationId: input.operationId,
      state: input.state,
    });
    state.phase5OperationByKey.set(input.key, receipt);
    state.phase5OperationDigestByKey.set(input.key, input.requestDigest);
    return Object.freeze({
      ...receipt,
      contractVersion: "workload-funnel.audited-operation/v1",
    });
  }

  const operations: Phase5SyntheticPublicOperations = {
    capacity: {
      observeCapacity(context) {
        assertSyntheticScope(context);
        const reserved = service.capacity();
        const now = clock();
        return Object.freeze({
          observedAt: now,
          snapshots: Object.freeze([
            Object.freeze({
              effective: Object.freeze({
                cpuMillis: Math.max(0, 8000 - reserved.reservedCpuMillis),
                memoryMiB: Math.max(0, 16_384 - reserved.reservedMemoryMiB),
              }),
              nodeId: "synthetic-node-1",
              nodeObservationRevision: 1,
              observedAt: now,
              poolId: "synthetic-pool",
              reasons: Object.freeze([]),
              recoveryReserved: Object.freeze({
                cpuMillis: 500,
                memoryMiB: 1024,
              }),
              reported: Object.freeze({ cpuMillis: 8000, memoryMiB: 16_384 }),
              status: "open",
            }),
          ]),
        });
      },
    },
    events: {
      acknowledge(context, mutation, consumerId, through, now) {
        assertSyntheticScope(context);
        const operationId = `consumer-ack:${context.effectiveTenantId}:${context.principalId}:${mutation.idempotencyKey}`;
        const prior = state.phase5ConsumerAckByOperation.get(operationId);
        if (prior !== undefined) {
          if (
            prior.consumerId !== consumerId ||
            prior.through.streamPosition !== through.streamPosition ||
            prior.through.eventId !== through.eventId
          )
            throw new Error("idempotency_key_conflict");
          return prior.registration;
        }
        const registration = [...state.phase5ConsumerByOperation.values()].find(
          (candidate) => candidate.consumerId === consumerId,
        );
        if (
          registration?.tenantId !== context.effectiveTenantId ||
          registration.leaseOwnerId !== context.principalId
        )
          throw new Error("not_found");
        if (
          mutation.expectedVersion !== undefined &&
          mutation.expectedVersion !== registration.version
        )
          throw new Error("version_conflict");
        const acknowledged = state.publicEventFeed.acknowledgeConsumer({
          consumerId,
          leaseFence: registration.leaseFence,
          leaseOwnerId: context.principalId,
          now,
          through,
        });
        for (const [key, candidate] of state.phase5ConsumerByOperation) {
          if (candidate.consumerId === consumerId)
            state.phase5ConsumerByOperation.set(key, acknowledged);
        }
        state.phase5ConsumerAckByOperation.set(
          operationId,
          Object.freeze({
            consumerId,
            registration: acknowledged,
            through: Object.freeze({ ...through }),
          }),
        );
        return acknowledged;
      },
      consume(context, consumerId, now) {
        assertSyntheticScope(context);
        const registration = [...state.phase5ConsumerByOperation.values()].find(
          (candidate) => candidate.consumerId === consumerId,
        );
        if (
          registration?.tenantId !== context.effectiveTenantId ||
          registration.leaseOwnerId !== context.principalId
        )
          throw new Error("not_found");
        const consumed = state.publicEventFeed.consume({
          consumerId,
          leaseFence: registration.leaseFence,
          leaseOwnerId: context.principalId,
          now,
        });
        for (const [key, candidate] of state.phase5ConsumerByOperation) {
          if (candidate.consumerId === consumerId)
            state.phase5ConsumerByOperation.set(key, consumed.registration);
        }
        return consumed;
      },
      page(context, input) {
        assertSyntheticScope(context);
        return state.publicEventFeed.page({
          ...input,
          tenantId: context.effectiveTenantId,
        });
      },
      registerConsumer(context, mutation, input, after, now) {
        assertSyntheticScope(context);
        const operationId = `consumer:${context.effectiveTenantId}:${context.principalId}:${mutation.idempotencyKey}`;
        const candidate = input as unknown as EventRegistrationInput;
        const registrationDigest = digest({
          after,
          consumerId: candidate.consumerId,
          limits: candidate.limits as PublicConsumerLimits,
          partition: candidate.partition ?? "control-1",
          snapshotWatermark:
            candidate.snapshotWatermark ?? after.streamPosition,
          streamClass: candidate.streamClass ?? "general",
        });
        const prior = state.phase5ConsumerByOperation.get(operationId);
        if (prior !== undefined) {
          if (
            state.phase5ConsumerRegistrationDigestByOperation.get(
              operationId,
            ) !== registrationDigest
          )
            throw new Error("idempotency_key_conflict");
          return prior;
        }
        if (
          mutation.expectedVersion !== undefined &&
          mutation.expectedVersion !== 0
        )
          throw new Error("version_conflict");
        if (
          typeof candidate.consumerId !== "string" ||
          candidate.consumerId.length < 1 ||
          candidate.consumerId.length > 128 ||
          typeof candidate.limits !== "object" ||
          candidate.limits === null
        )
          throw new Error("invalid_consumer_registration");
        const registration = state.publicEventFeed.registerConsumer({
          consumerId: candidate.consumerId,
          leaseOwnerId: context.principalId,
          limits: candidate.limits as PublicConsumerLimits,
          now,
          partition: candidate.partition ?? "control-1",
          snapshotWatermark:
            candidate.snapshotWatermark ?? after.streamPosition,
          start: after,
          streamClass: candidate.streamClass ?? "general",
          tenantId: context.effectiveTenantId,
        });
        state.phase5ConsumerByOperation.set(operationId, registration);
        state.phase5ConsumerRegistrationDigestByOperation.set(
          operationId,
          registrationDigest,
        );
        return registration;
      },
      snapshot(context, partition, now) {
        assertSyntheticScope(context);
        return state.publicEventFeed.snapshot({
          generatedAt: now,
          partition,
          readItems: () =>
            [...state.runById.keys()]
              .map((runId) => service.status(runId))
              .filter(
                (item): item is WorkloadStatus =>
                  item?.workload.tenantId === context.effectiveTenantId,
              ),
          tenantId: context.effectiveTenantId,
        });
      },
    },
    reconciliation: {
      list(context, afterItemId, limit) {
        assertSyntheticScope(context);
        const items = [
          ...[...state.dispatches.values()]
            .filter((item) =>
              ["unknown", "reconciliation_required"].includes(item.observed),
            )
            .map((item) => ({
              itemId: item.dispatchId,
              kind: "dispatch" as const,
              observedAt: clock(),
              reason: item.observed,
              state: item.observed,
            })),
          ...[...state.executions.values()]
            .filter((item) =>
              ["unknown", "reconciliation_required"].includes(item.state),
            )
            .map((item) => ({
              itemId: item.executionId,
              kind: "execution" as const,
              observedAt: clock(),
              reason: item.state,
              state: item.state,
            })),
          ...[...state.ownershipTransfers.values()]
            .filter((item) => item.state !== "completed")
            .map((item) => ({
              itemId: item.operationId,
              kind: "ownership_transfer" as const,
              observedAt: clock(),
              reason: item.state,
              state: item.state,
            })),
        ].sort((left, right) => left.itemId.localeCompare(right.itemId));
        return Object.freeze(
          items
            .filter(
              (item) => afterItemId === undefined || item.itemId > afterItemId,
            )
            .slice(0, limit)
            .map((item) => Object.freeze(item)),
        );
      },
    },
    results: {
      audit(context, afterSequence, limit) {
        assertSyntheticScope(context);
        return Object.freeze(
          audit
            .records()
            .filter(
              (record) =>
                record.sequence > afterSequence &&
                (record.affectedResources?.includes(
                  context.effectiveTenantId,
                ) === true ||
                  state.workloadById.get(record.resourceId)?.tenantId ===
                    context.effectiveTenantId ||
                  state.runById.get(record.resourceId) !== undefined ||
                  state.attemptById.get(record.resourceId) !== undefined),
            )
            .slice(0, limit)
            .map((record) =>
              Object.freeze({
                action: record.action,
                actorId: pseudonymizeReferences(record.actorId),
                affectedResources:
                  record.affectedResources === undefined
                    ? Object.freeze([pseudonymizeReferences(record.resourceId)])
                    : Object.freeze(
                        record.affectedResources.map((resource) =>
                          pseudonymizeReferences(resource),
                        ),
                      ),
                auditId: record.auditId,
                authorizationPolicyVersion: record.policyVersion ?? 1,
                correlationId: pseudonymizeReferences(
                  record.correlationId ?? record.eventId,
                ),
                hash: record.hash,
                occurredAt: record.occurredAt ?? 0,
                previousHash: record.previousHash,
                reason: pseudonymizeReferences(
                  record.reason ?? "canonical_lifecycle",
                ),
                ...(record.nextState === undefined
                  ? {}
                  : { nextState: record.nextState }),
                ...(record.previousState === undefined
                  ? {}
                  : { previousState: record.previousState }),
              }),
            ),
        );
      },
      requestErasure(context, request) {
        assertSyntheticScope(context);
        const key = operationKey(
          context,
          "erasure",
          request.mutation.idempotencyKey,
        );
        const requestDigest = digest({
          dataClasses: [...request.dataClasses].sort(),
          expectedVersion: request.mutation.expectedVersion,
          reason: request.reason,
          subjectReference: request.subjectReference,
        });
        const prior = priorOperation(key, requestDigest);
        if (prior !== undefined) return prior;
        if (request.dataClasses.includes("artifacts"))
          assertGateOpen(state.gateSet, "result_delete");
        const operationId = `erasure:${digest(key).slice(0, 24)}`;
        const held = state.legalHoldSubjects.has(request.subjectReference);
        const pseudonym = `erased-${digest(`${context.effectiveTenantId}:${request.subjectReference}`).slice(0, 24)}`;
        const erasureRecord = database.erasureLedger.append({
          dataClasses: request.dataClasses,
          operationId,
          pseudonym,
          reasonDigest: digest(request.reason),
          requestedAt: clock(),
          state: held ? "pending_legal_hold" : "completed",
          subjectDigest: syntheticErasureSubjectDigest(
            context.effectiveTenantId,
            request.subjectReference,
          ),
          tenantId: context.effectiveTenantId,
        });
        if (!held) {
          service.erasePrincipalReferences({
            operationId,
            pseudonym,
            subjectPrincipalId: request.subjectReference,
          });
          state.erasedSubjectPseudonyms.set(
            request.subjectReference,
            pseudonym,
          );
        }
        state.erasureLedgerSequence = erasureRecord.sequence;
        const receipt = recordOperation({
          action: "data.erasure-requested",
          affectedResources: Object.freeze([request.subjectReference]),
          context,
          correlationId: request.mutation.correlationId,
          idempotencyKey: request.mutation.idempotencyKey,
          key,
          nextState: held ? "pending_legal_hold" : "completed",
          operationId,
          previousState: "identified",
          reason: request.reason,
          requestDigest,
          state: held ? "pending_legal_hold" : "completed",
        });
        emit(
          operationId,
          "DataErasureRecorded",
          { ...context, correlationId: request.mutation.correlationId },
          operationId,
          {
            dataClasses: Object.freeze([...request.dataClasses]),
            erasureLedgerSequence: state.erasureLedgerSequence,
            state: receipt.state,
          },
        );
        return receipt;
      },
      requestRetention(context, resultManifestId, request) {
        assertSyntheticScope(context);
        if (!manifestBelongs(context, resultManifestId))
          throw new Error("not_found");
        const key = operationKey(
          context,
          `retention.${request.action}`,
          request.mutation.idempotencyKey,
        );
        const requestDigest = digest({
          action: request.action,
          expectedVersion: request.mutation.expectedVersion,
          reason: request.reason,
          resultManifestId,
        });
        const prior = priorOperation(key, requestDigest);
        if (prior !== undefined) return prior;
        const operationId = `retention:${digest(key).slice(0, 24)}`;
        const previous = service.result(resultManifestId);
        const next = service.requestRetention({
          action: request.action,
          operationId,
          resultManifestId,
          ...(request.mutation.expectedVersion === undefined
            ? {}
            : { expectedVersion: request.mutation.expectedVersion }),
        });
        const receipt = recordOperation({
          action: `result.retention-${request.action}-requested`,
          affectedResources: Object.freeze([resultManifestId]),
          context,
          correlationId: request.mutation.correlationId,
          idempotencyKey: request.mutation.idempotencyKey,
          key,
          nextState: next.retentionState,
          operationId,
          reason: request.reason,
          requestDigest,
          state: "accepted",
          ...(previous === undefined
            ? {}
            : { previousState: previous.retentionState }),
        });
        emit(
          operationId,
          "ResultRetentionRequested",
          { ...context, correlationId: request.mutation.correlationId },
          resultManifestId,
          { action: request.action, retentionState: next.retentionState },
          { aggregateVersion: next.version },
        );
        return receipt;
      },
      result(context, resultManifestId) {
        assertSyntheticScope(context);
        return manifestBelongs(context, resultManifestId)
          ? service.result(resultManifestId)
          : undefined;
      },
    },
    workloads: {
      cancel(context, runId, reason) {
        assertSyntheticScope(context);
        const previous = status(context, runId);
        if (previous === undefined) throw new Error("not_found");
        const key = operationKey(context, "cancel", context.idempotencyKey);
        const requestDigest = digest({
          expectedVersion: context.expectedVersion,
          reason,
          runId,
        });
        const priorDigest = state.phase5MutationDigestByKey.get(key);
        if (priorDigest !== undefined) {
          if (priorDigest !== requestDigest)
            throw new Error("idempotency_key_conflict");
          const duplicate = service.cancel(runId, context.idempotencyKey);
          return Object.freeze({
            ...duplicate,
            operationId: publicOperationId(duplicate.operationId),
          });
        }
        if (
          context.expectedVersion !== undefined &&
          context.expectedVersion !== previous.run.version
        )
          throw new Error("version_conflict");
        const canonicalReceipt = service.cancel(runId, context.idempotencyKey);
        const receipt = Object.freeze({
          ...canonicalReceipt,
          operationId: publicOperationId(canonicalReceipt.operationId),
        });
        state.phase5MutationDigestByKey.set(key, requestDigest);
        const next = status(context, runId);
        if (next === undefined) throw new Error("not_found");
        audit.append(
          `public-audit:${receipt.operationId}`,
          context.principalId,
          "run.cancellation-requested",
          runId,
          {
            affectedResources: Object.freeze([
              context.effectiveTenantId,
              runId,
              previous.attempt.attemptId,
            ]),
            correlationId: context.correlationId,
            nextState: "cancellation_requested",
            occurredAt: clock(),
            policyVersion: context.authorizationPolicyVersion,
            previousState: previous.run.state,
            reason,
          },
        );
        emit(
          receipt.operationId,
          "WorkloadCancellationRequested",
          context,
          runId,
          { status: receipt.status },
          {
            aggregateVersion: next.run.version,
            streamClass: "cancellation",
          },
        );
        return receipt;
      },
      explanation(context, runId) {
        const found = status(context, runId);
        if (found === undefined) return undefined;
        const gateOpen = state.gateSet.open.has("admission_reservation");
        return Object.freeze({
          admissionPolicyRevision: 1,
          attemptId: found.attempt.attemptId,
          details: Object.freeze([
            gateOpen ? "synthetic_capacity_available" : "operation_gate_closed",
          ]),
          evaluatedAt: clock(),
          fairnessRevision: state.reservationRevision,
          nodeObservationRevision: 1,
          outcome: gateOpen ? "admit" : "defer",
          reason: gateOpen ? "admissible" : "hard_safety_bound",
          reservationLedgerRevision: state.reservationRevision,
        });
      },
      observe: status,
      operation(context, operationId) {
        assertSyntheticScope(context);
        const canonicalOperationId =
          state.phase5CanonicalOperationByPublicId.get(operationId);
        if (canonicalOperationId === undefined) return undefined;
        const operation = service.operationStatus(canonicalOperationId);
        if (operation === undefined) return undefined;
        return status(context, operation.resourceId) === undefined
          ? undefined
          : Object.freeze({ ...operation, operationId });
      },
      submit(context, spec) {
        assertSyntheticScope(context);
        if (
          context.expectedVersion !== undefined &&
          context.expectedVersion !== 0
        )
          throw new Error("version_conflict");
        const canonicalReceipt = service.submit({
          idempotencyKey: context.idempotencyKey,
          spec,
        });
        const receipt = Object.freeze({
          ...canonicalReceipt,
          operationId: publicOperationId(canonicalReceipt.operationId),
        });
        const publicAuditEventId = `public-audit:${receipt.operationId}`;
        if (
          !audit.records().some((item) => item.eventId === publicAuditEventId)
        )
          audit.append(
            publicAuditEventId,
            context.principalId,
            "workload.accepted",
            receipt.workloadId,
            {
              affectedResources: Object.freeze([
                context.effectiveTenantId,
                receipt.workloadId,
                receipt.runId,
                receipt.attemptId,
              ]),
              correlationId: context.correlationId,
              nextState: "accepted",
              occurredAt: clock(),
              policyVersion: context.authorizationPolicyVersion,
              previousState: "absent",
              reason: "api_submit",
            },
          );
        const accepted = status(context, receipt.runId);
        if (accepted === undefined) throw new Error("not_found");
        emit(
          receipt.operationId,
          "WorkloadAccepted",
          context,
          receipt.runId,
          {
            attemptId: receipt.attemptId,
            workloadId: receipt.workloadId,
          },
          { aggregateVersion: accepted.run.version },
        );
        return receipt;
      },
    },
  };
  return Object.freeze(operations);
}
