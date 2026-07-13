import type {
  Allocation,
  AllocationReleaseReceipt,
  ReservationRollbackReceipt,
} from "@workload-funnel/workload-control/allocation-leasing";
import type { AuditRecord } from "@workload-funnel/workload-control/audit-history";
import type { ReconciliationClaim } from "@workload-funnel/workload-control/canonical-transaction-coordination";
import type { CancellationSaga } from "@workload-funnel/workload-control/cancellation";
import type {
  InboxReceipt,
  OutboxMessage,
  StatusProjection,
} from "@workload-funnel/workload-control/control-event-delivery";
import {
  createInMemoryPublicEventFeed,
  type PublicEventFeed,
  type PublicConsumerRegistration,
} from "@workload-funnel/workload-control/control-event-delivery";
import type {
  Dispatch,
  DispatchMapping,
} from "@workload-funnel/workload-control/dispatch-reconciliation";
import type { ArtifactFinalizeCommand } from "@workload-funnel/workload-control/result-management";
import type { LocalDispatchFenceHighWatermark } from "@workload-funnel/dispatcher-local/dispatch-submission";
import type { Execution } from "@workload-funnel/workload-control/execution-reconciliation";
import {
  createClosedGateSet,
  openSyntheticTestGates,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type { OwnershipTransferOperation } from "@workload-funnel/workload-control/ownership-transfer";
import type { ResultManifest } from "@workload-funnel/workload-control/result-management";
import type {
  AcceptanceReceipt,
  Attempt,
  CancellationReceipt,
  OperationStatus,
  Run,
  Workload,
} from "@workload-funnel/workload-control/workload-lifecycle";

import {
  createSyntheticErasureLedger,
  type SyntheticErasureLedger,
} from "./synthetic-erasure-ledger.js";

export interface SyntheticArtifactWriter {
  readonly root: string;
  write(command: ArtifactFinalizeCommand): string;
}

export type SyntheticDatabaseProfile = "postgres" | "sqlite";

export interface SyntheticPhase5Operation {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly state:
    | "accepted"
    | "completed"
    | "pending_legal_hold"
    | "reconciliation_required";
  readonly auditId: string;
  readonly duplicate: boolean;
}

export interface SyntheticConsumerAcknowledgement {
  readonly consumerId: string;
  readonly through: Readonly<{ streamPosition: number; eventId: string }>;
  readonly registration: PublicConsumerRegistration;
}

export interface DurableState {
  readonly schemaTables: readonly string[];
  sequence: number;
  allocationSequence: number;
  workloadById: Map<string, Workload>;
  runById: Map<string, Run>;
  attemptById: Map<string, Attempt>;
  acceptanceByKey: Map<string, AcceptanceReceipt>;
  acceptanceDigestByKey: Map<string, string>;
  operationById: Map<string, OperationStatus>;
  cancelOperationByRun: Map<string, string>;
  cancellationReceiptByOperation: Map<string, CancellationReceipt>;
  lifecycleErasureByOperation: Map<string, number>;
  allocations: Map<string, Allocation>;
  allocationByAttempt: Map<string, string>;
  releaseReceipts: Map<string, AllocationReleaseReceipt>;
  rollbackReceipts: Map<string, ReservationRollbackReceipt>;
  terminalIntentAttempts: Set<string>;
  terminalReleaseAttempts: Set<string>;
  dispatches: Map<string, Dispatch>;
  dispatchByAllocation: Map<string, string>;
  localDispatchEffects: Map<string, "accepted" | "canceled">;
  localDispatchHighWatermarks: Map<string, LocalDispatchFenceHighWatermark>;
  mappings: Map<string, DispatchMapping>;
  executions: Map<string, Execution>;
  executionByDispatch: Map<string, string>;
  manifests: Map<string, ResultManifest>;
  manifestByAttempt: Map<string, string>;
  outbox: Map<string, OutboxMessage>;
  inbox: Map<string, InboxReceipt>;
  projections: Map<string, StatusProjection>;
  audit: AuditRecord[];
  sagas: Map<string, CancellationSaga>;
  claims: Map<string, ReconciliationClaim>;
  ownershipTransfers: Map<string, OwnershipTransferOperation>;
  claimFence: number;
  gateSet: OperationGateSet;
  queuedCount: number;
  reservedCpuMillis: number;
  reservedMemoryMiB: number;
  reservationRevision: number;
  rejectNextAttachment: boolean;
  failAttachmentRejection: "none" | "before-commit" | "after-commit";
  lockTrace: string[];
  publicEventFeed: PublicEventFeed;
  publicEventIds: Set<string>;
  phase5OperationByKey: Map<string, SyntheticPhase5Operation>;
  phase5OperationDigestByKey: Map<string, string>;
  phase5MutationDigestByKey: Map<string, string>;
  phase5CanonicalOperationByPublicId: Map<string, string>;
  phase5PublicOperationByCanonicalId: Map<string, string>;
  legalHoldSubjects: Set<string>;
  erasureLedgerSequence: number;
  erasedSubjectPseudonyms: Map<string, string>;
  phase5ConsumerByOperation: Map<string, PublicConsumerRegistration>;
  phase5ConsumerRegistrationDigestByOperation: Map<string, string>;
  phase5ConsumerAckByOperation: Map<string, SyntheticConsumerAcknowledgement>;
}

export interface SyntheticDatabase {
  readonly profile: SyntheticDatabaseProfile;
  readonly state: DurableState;
  readonly artifacts: SyntheticArtifactWriter;
  readonly erasureLedger: SyntheticErasureLedger;
}

function createState(): DurableState {
  const namespaceId = "test://phase1/walking-slice";
  return {
    acceptanceByKey: new Map(),
    acceptanceDigestByKey: new Map(),
    allocationByAttempt: new Map(),
    allocationSequence: 0,
    allocations: new Map(),
    attemptById: new Map(),
    audit: [],
    cancelOperationByRun: new Map(),
    cancellationReceiptByOperation: new Map(),
    claimFence: 0,
    claims: new Map(),
    dispatchByAllocation: new Map(),
    dispatches: new Map(),
    executionByDispatch: new Map(),
    executions: new Map(),
    erasedSubjectPseudonyms: new Map(),
    failAttachmentRejection: "none",
    gateSet: openSyntheticTestGates(createClosedGateSet(namespaceId), 0),
    inbox: new Map(),
    lockTrace: [],
    localDispatchEffects: new Map(),
    localDispatchHighWatermarks: new Map(),
    lifecycleErasureByOperation: new Map(),
    manifestByAttempt: new Map(),
    manifests: new Map(),
    mappings: new Map(),
    operationById: new Map(),
    outbox: new Map(),
    ownershipTransfers: new Map(),
    phase5OperationByKey: new Map(),
    phase5OperationDigestByKey: new Map(),
    phase5MutationDigestByKey: new Map(),
    phase5CanonicalOperationByPublicId: new Map(),
    phase5PublicOperationByCanonicalId: new Map(),
    phase5ConsumerByOperation: new Map(),
    phase5ConsumerRegistrationDigestByOperation: new Map(),
    phase5ConsumerAckByOperation: new Map(),
    projections: new Map(),
    publicEventFeed: createInMemoryPublicEventFeed(),
    publicEventIds: new Set(),
    queuedCount: 0,
    rejectNextAttachment: false,
    releaseReceipts: new Map(),
    reservationRevision: 0,
    reservedCpuMillis: 0,
    reservedMemoryMiB: 0,
    rollbackReceipts: new Map(),
    runById: new Map(),
    sagas: new Map(),
    schemaTables: Object.freeze([
      "workloads",
      "runs",
      "attempts",
      "tenants",
      "queued_work_ledger",
      "allocations",
      "capacity_reservation_ledger",
      "dispatches",
      "dispatch_mappings",
      "executions",
      "result_manifests",
      "idempotency_operations",
      "canonical_bundle_receipts",
      "command_inbox",
      "transactional_outbox",
      "recovery_debt_ledger",
      "disk_budget_ledger",
      "audit_ledger",
      "status_projection",
      "reconciliation_claims",
      "cancellation_coordinators",
      "ownership_transfer_coordinators",
      "operation_gates",
    ]),
    sequence: 0,
    terminalIntentAttempts: new Set(),
    terminalReleaseAttempts: new Set(),
    legalHoldSubjects: new Set(),
    erasureLedgerSequence: 0,
    workloadById: new Map(),
  };
}

export function createSyntheticDatabase(
  profile: SyntheticDatabaseProfile,
  artifacts: SyntheticArtifactWriter = Object.freeze({
    root: "",
    write() {
      throw new Error("No filesystem artifact provider is configured");
    },
  }),
  erasureLedger: SyntheticErasureLedger = createSyntheticErasureLedger(),
): SyntheticDatabase {
  return Object.freeze({
    artifacts,
    erasureLedger,
    profile,
    state: createState(),
  });
}
