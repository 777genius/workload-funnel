import type { Phase1SyntheticService } from "./synthetic-relational-profile.js";
import type { SyntheticPhase5Operation } from "./synthetic-state.js";

import type { DerivedCapacitySnapshot } from "@workload-funnel/workload-control/capacity-management";
import type {
  PublicConsumerRegistration,
  PublicEventPage,
  PublicSnapshotV1,
  PublicStreamClass,
} from "@workload-funnel/workload-control/control-event-delivery";
import type { Dispatch } from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { Execution } from "@workload-funnel/workload-control/execution-reconciliation";
import type { OwnershipTransferOperation } from "@workload-funnel/workload-control/ownership-transfer";
import type { AdmissionExplanation } from "@workload-funnel/workload-control/tenant-admission";
import type {
  WorkloadSpec,
  WorkloadStatus,
} from "@workload-funnel/workload-control/workload-lifecycle";

export interface RequestContext {
  readonly principalId: string;
  readonly effectiveTenantId: string;
  readonly authorizationPolicyVersion: number;
}

export interface MutationContext extends RequestContext {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly expectedVersion?: number;
}

interface MutationEnvelope {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly expectedVersion?: number;
}

interface AuditOperationRequest {
  readonly mutation: MutationEnvelope;
  readonly reason: string;
}

interface ErasureOperationRequest extends AuditOperationRequest {
  readonly subjectReference: string;
  readonly dataClasses: readonly string[];
}

export interface EventRegistrationInput {
  readonly consumerId: string;
  readonly partition?: string;
  readonly streamClass?: PublicStreamClass;
  readonly limits: unknown;
  readonly snapshotWatermark?: number;
}

interface SyntheticAuditViewRecord {
  readonly auditId: string;
  readonly actorId: string;
  readonly action: string;
  readonly reason: string;
  readonly authorizationPolicyVersion: number;
  readonly previousState?: string;
  readonly nextState?: string;
  readonly correlationId: string;
  readonly affectedResources: readonly string[];
  readonly occurredAt: number;
  readonly previousHash: string;
  readonly hash: string;
}

interface SyntheticReconciliationItem {
  readonly itemId: string;
  readonly kind: "dispatch" | "execution" | "ownership_transfer";
  readonly state:
    | Dispatch["observed"]
    | Execution["state"]
    | OwnershipTransferOperation["state"];
  readonly reason: string;
  readonly observedAt: number;
}

export interface Phase5SyntheticPublicOperations {
  readonly workloads: {
    submit(
      context: MutationContext,
      spec: WorkloadSpec,
    ): ReturnType<Phase1SyntheticService["submit"]>;
    observe(context: RequestContext, runId: string): WorkloadStatus | undefined;
    cancel(
      context: MutationContext,
      runId: string,
      reason: string,
    ): ReturnType<Phase1SyntheticService["cancel"]>;
    operation(
      context: RequestContext,
      operationId: string,
    ): ReturnType<Phase1SyntheticService["operationStatus"]>;
    explanation(
      context: RequestContext,
      runId: string,
    ): AdmissionExplanation | undefined;
  };
  readonly capacity: {
    observeCapacity(context: RequestContext): Readonly<{
      observedAt: number;
      snapshots: readonly DerivedCapacitySnapshot[];
    }>;
  };
  readonly results: {
    result(
      context: RequestContext,
      resultManifestId: string,
    ): ReturnType<Phase1SyntheticService["result"]>;
    requestRetention(
      context: RequestContext,
      resultManifestId: string,
      request: AuditOperationRequest &
        Readonly<{ action: "archive" | "delete" }>,
    ): SyntheticPhase5Operation &
      Readonly<{ contractVersion: "workload-funnel.audited-operation/v1" }>;
    requestErasure(
      context: RequestContext,
      request: ErasureOperationRequest,
    ): SyntheticPhase5Operation &
      Readonly<{ contractVersion: "workload-funnel.audited-operation/v1" }>;
    audit(
      context: RequestContext,
      afterSequence: number,
      limit: number,
    ): readonly SyntheticAuditViewRecord[];
  };
  readonly reconciliation: {
    list(
      context: RequestContext,
      afterItemId: string | undefined,
      limit: number,
    ): readonly SyntheticReconciliationItem[];
  };
  readonly events: {
    snapshot(
      context: RequestContext,
      partition: string,
      now: number,
    ): PublicSnapshotV1<WorkloadStatus>;
    page(
      context: RequestContext,
      input: Readonly<{
        partition: string;
        streamClass?: PublicStreamClass;
        after: Readonly<{ streamPosition: number; eventId: string }>;
        snapshotWatermark: number;
        limit: number;
      }>,
    ): PublicEventPage;
    registerConsumer(
      context: RequestContext,
      mutation: MutationContext,
      input: Readonly<Record<string, unknown>>,
      after: Readonly<{ streamPosition: number; eventId: string }>,
      now: number,
    ): PublicConsumerRegistration;
    consume(
      context: RequestContext,
      consumerId: string,
      now: number,
    ): Readonly<{
      registration: PublicConsumerRegistration;
      page: PublicEventPage;
    }>;
    acknowledge(
      context: RequestContext,
      mutation: MutationContext,
      consumerId: string,
      through: Readonly<{ streamPosition: number; eventId: string }>,
      now: number,
    ): PublicConsumerRegistration;
  };
}
