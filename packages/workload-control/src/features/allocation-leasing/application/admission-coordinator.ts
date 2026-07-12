import {
  fitsResources,
  laneCapacity,
  subtractResources,
  type DerivedCapacitySnapshot,
  type SafetyBoundDecision,
} from "@workload-funnel/workload-control/capacity-management";
import {
  StaleFairnessDecisionError,
  selectFairAdmission,
  type AdmissionCapacityCandidate,
  type AdmissionPlan,
  type AdmissionPolicy,
  type AdmissionSelection,
  type QueuedWorkload,
  type SerializedFairnessLedger,
} from "@workload-funnel/workload-control/tenant-admission";

import {
  StaleCapacityDecisionError,
  type CapacityLedgerSnapshot,
  type ResourceReservation,
  type SerializedCapacityReservationLedger,
} from "../domain/resource-reservation-ledger.js";

export interface CapacitySource {
  readonly capacity: DerivedCapacitySnapshot;
  readonly ledger: SerializedCapacityReservationLedger;
  readonly capabilities: readonly string[];
  readonly capabilityRevision: number;
  readonly fairnessDimensions: readonly string[];
}

export interface CommittedAdmission {
  readonly reservation: ResourceReservation;
  readonly fairnessRevision: number;
  readonly reservationLedgerRevision: number;
  readonly explanation: AdmissionPlan["explanation"];
}

function candidate(
  source: CapacitySource,
  recoveryQueued: boolean,
): AdmissionCapacityCandidate {
  if (source.fairnessDimensions.length === 0)
    throw new Error("fairness_dimensions_required");
  const ledger = source.ledger.snapshot();
  if (
    ledger.nodeId !== source.capacity.nodeId ||
    ledger.poolId !== source.capacity.poolId
  )
    throw new Error("capacity_source_identity_mismatch");
  return Object.freeze({
    capabilities: Object.freeze([...source.capabilities].sort()),
    capabilityRevision: source.capabilityRevision,
    fairnessDimensions: Object.freeze([...source.fairnessDimensions].sort()),
    maximumEnvelope: source.capacity.reported,
    producerAvailable: subtractResources(
      laneCapacity(source.capacity, "producer", recoveryQueued),
      ledger.reserved,
    ),
    recoveryAvailable: subtractResources(
      laneCapacity(source.capacity, "recovery", recoveryQueued),
      ledger.reserved,
    ),
    reservationLedgerRevision: ledger.reservationLedgerRevision,
    snapshot: source.capacity,
  });
}

export class AdmissionCoordinator {
  readonly #fairness: SerializedFairnessLedger;
  readonly #sources: readonly CapacitySource[];

  public constructor(
    fairness: SerializedFairnessLedger,
    sources: readonly CapacitySource[],
  ) {
    this.#fairness = fairness;
    this.#sources = Object.freeze([...sources]);
  }

  public plan(
    input: Readonly<{
      queue: readonly QueuedWorkload[];
      policy: AdmissionPolicy;
      safety: SafetyBoundDecision;
      now: number;
    }>,
  ): AdmissionSelection {
    const recoveryQueued = input.queue.some(
      (workload) =>
        workload.lane === "recovery" &&
        this.#sources.some(
          (source) =>
            workload.compatiblePoolIds.includes(source.capacity.poolId) &&
            workload.requiredCapabilities.every((capability) =>
              source.capabilities.includes(capability),
            ) &&
            fitsResources(workload.resources, source.capacity.reported),
        ),
    );
    return selectFairAdmission({
      candidates: this.#sources.map((source) =>
        candidate(source, recoveryQueued),
      ),
      fairness: this.#fairness.snapshot(),
      now: input.now,
      policy: input.policy,
      queue: input.queue,
      safety: input.safety,
    });
  }

  public commit(
    plan: AdmissionPlan,
    allocationId: string,
    currentPolicy: AdmissionPolicy,
    currentSafety: SafetyBoundDecision = Object.freeze({
      reasons: Object.freeze([]),
      status: "open",
    }),
  ): CommittedAdmission {
    if (currentPolicy.revision !== plan.explanation.admissionPolicyRevision)
      throw new Error("stale_admission_policy_revision");
    if (currentSafety.status === "closed") throw new Error("hard_safety_bound");
    const fairnessBefore = this.#fairness.snapshot();
    if (fairnessBefore.fairnessRevision !== plan.expectedFairnessRevision)
      throw new StaleFairnessDecisionError();
    const source = this.#sources.find(
      (value) => value.capacity.nodeId === plan.candidate.snapshot.nodeId,
    );
    if (source === undefined) throw new Error("capacity_source_missing");
    if (source.capabilityRevision !== plan.candidate.capabilityRevision)
      throw new Error("stale_capability_revision");
    const capacityBefore: CapacityLedgerSnapshot = source.ledger.snapshot();
    if (
      capacityBefore.reservationLedgerRevision !==
      plan.candidate.reservationLedgerRevision
    )
      throw new StaleCapacityDecisionError("reservation_revision");
    if (
      capacityBefore.nodeObservationRevision !==
      plan.candidate.snapshot.nodeObservationRevision
    )
      throw new StaleCapacityDecisionError("node_observation_revision");

    this.#fairness.assertReservable(
      plan.workload,
      currentPolicy,
      plan.expectedFairnessRevision,
      plan.candidate.snapshot.poolId,
    );
    const reservation = source.ledger.reserve({
      allocationId,
      attemptId: plan.workload.attemptId,
      expectedNodeObservationRevision:
        plan.candidate.snapshot.nodeObservationRevision,
      expectedReservationLedgerRevision:
        plan.candidate.reservationLedgerRevision,
      resources: plan.workload.resources,
      tenantId: plan.workload.tenantId,
      workloadClass: plan.workload.workloadClass,
    });
    const fairnessAfter = this.#fairness.reserve(
      plan.workload,
      currentPolicy,
      plan.expectedFairnessRevision,
      plan.candidate.snapshot.poolId,
    );
    return Object.freeze({
      explanation: plan.explanation,
      fairnessRevision: fairnessAfter.fairnessRevision,
      reservation,
      reservationLedgerRevision: reservation.reservationLedgerRevision,
    });
  }
}
