import type {
  DerivedCapacitySnapshot,
  ResourceAmounts,
  SafetyBoundDecision,
} from "@workload-funnel/workload-control/capacity-management";

export type WorkloadLane = "producer" | "recovery";

export interface QueuedWorkload {
  readonly attemptId: string;
  readonly tenantId: string;
  readonly workloadClass: string;
  readonly lane: WorkloadLane;
  readonly resources: ResourceAmounts;
  readonly priority: number;
  readonly enqueuedAt: number;
  readonly deadlineAt?: number;
  readonly requiredCapabilities: readonly string[];
  readonly compatiblePoolIds: readonly string[];
  readonly bypassCount: number;
}

export interface WorkloadClassPolicy {
  readonly weight: number;
  readonly maxConcurrent: number;
  readonly resourceQuota: ResourceAmounts;
}

export interface TenantFairnessPolicy {
  readonly tenantId: string;
  readonly weight: number;
  readonly maxConcurrent: number;
  readonly resourceQuota: ResourceAmounts;
  readonly classes: Readonly<Record<string, WorkloadClassPolicy>>;
}

export interface AdmissionPolicy {
  readonly revision: number;
  readonly tenants: Readonly<Record<string, TenantFairnessPolicy>>;
  readonly maxBypassCount: number;
  readonly maxQueueAgeMs: number;
  readonly agingIntervalMs: number;
  readonly maxAgingBoost: number;
  readonly deadlineBoostWindowMs: number;
}

export interface FairnessChargeSnapshot {
  readonly fairnessRevision: number;
  readonly tenantResources: Readonly<Record<string, ResourceAmounts>>;
  readonly tenantConcurrent: Readonly<Record<string, number>>;
  readonly classResources: Readonly<Record<string, ResourceAmounts>>;
  readonly poolTenantResources: Readonly<Record<string, ResourceAmounts>>;
  readonly poolClassResources: Readonly<Record<string, ResourceAmounts>>;
  readonly classConcurrent: Readonly<Record<string, number>>;
}

export interface AdmissionCapacityCandidate {
  readonly snapshot: DerivedCapacitySnapshot;
  readonly capabilityRevision: number;
  readonly reservationLedgerRevision: number;
  readonly producerAvailable: ResourceAmounts;
  readonly recoveryAvailable: ResourceAmounts;
  readonly maximumEnvelope: ResourceAmounts;
  readonly capabilities: readonly string[];
  readonly fairnessDimensions: readonly string[];
}

export type AdmissionReasonCode =
  | "admissible"
  | "deadline_elapsed"
  | "hard_safety_bound"
  | "tenant_unknown"
  | "class_unknown"
  | "tenant_concurrency_quota"
  | "tenant_resource_quota"
  | "class_concurrency_quota"
  | "class_resource_quota"
  | "invalid_resource_request"
  | "missing_capability"
  | "permanently_unschedulable"
  | "pressure_closed"
  | "capacity_unavailable"
  | "large_workload_reserved";

export interface AdmissionExplanation {
  readonly attemptId: string;
  readonly outcome: "admit" | "defer" | "reject";
  readonly reason: AdmissionReasonCode;
  readonly details: readonly string[];
  readonly admissionPolicyRevision: number;
  readonly fairnessRevision: number;
  readonly nodeObservationRevision?: number;
  readonly capabilityRevision?: number;
  readonly reservationLedgerRevision?: number;
  readonly evaluatedAt: number;
}

export interface AdmissionPlan {
  readonly workload: QueuedWorkload;
  readonly candidate: AdmissionCapacityCandidate;
  readonly explanation: AdmissionExplanation;
  readonly expectedFairnessRevision: number;
}

export interface AdmissionSelection {
  readonly plan?: AdmissionPlan;
  readonly explanations: readonly AdmissionExplanation[];
  readonly reservedAttemptId?: string;
}

function amount(
  source: ResourceAmounts | undefined,
  dimension: string,
): number {
  return source?.[dimension] ?? 0;
}

function validateAdmissionPolicy(policy: AdmissionPolicy): void {
  if (
    !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1 ||
    policy.maxBypassCount < 0 ||
    policy.maxQueueAgeMs < 0 ||
    policy.agingIntervalMs <= 0 ||
    policy.maxAgingBoost < 0 ||
    policy.deadlineBoostWindowMs < 0
  ) {
    throw new Error("invalid_admission_policy");
  }
  for (const tenant of Object.values(policy.tenants)) {
    if (tenant.weight <= 0 || tenant.maxConcurrent < 0) {
      throw new Error("invalid_tenant_fairness_policy");
    }
    for (const workloadClass of Object.values(tenant.classes)) {
      if (workloadClass.weight <= 0 || workloadClass.maxConcurrent < 0) {
        throw new Error("invalid_class_fairness_policy");
      }
    }
  }
}

function validResourceRequest(resources: ResourceAmounts): boolean {
  const amounts = Object.values(resources);
  return (
    amounts.length > 0 &&
    amounts.some((value) => value > 0) &&
    amounts.every((value) => Number.isSafeInteger(value) && value >= 0)
  );
}

function exceeds(
  current: ResourceAmounts | undefined,
  request: ResourceAmounts,
  limit: ResourceAmounts,
): boolean {
  return Object.entries(request).some(
    ([dimension, requested]) =>
      amount(current, dimension) + requested > amount(limit, dimension),
  );
}

function fits(request: ResourceAmounts, capacity: ResourceAmounts): boolean {
  return Object.entries(request).every(
    ([dimension, requested]) => requested <= amount(capacity, dimension),
  );
}

function classKey(workload: QueuedWorkload): string {
  return `${workload.tenantId}/${workload.workloadClass}`;
}

function poolTenantKey(poolId: string, tenantId: string): string {
  return `${poolId}/${tenantId}`;
}

function poolClassKey(poolId: string, workload: QueuedWorkload): string {
  return `${poolId}/${classKey(workload)}`;
}

function explanation(
  workload: QueuedWorkload,
  policy: AdmissionPolicy,
  fairness: FairnessChargeSnapshot,
  now: number,
  outcome: AdmissionExplanation["outcome"],
  reason: AdmissionReasonCode,
  details: readonly string[] = [],
  candidate?: AdmissionCapacityCandidate,
): AdmissionExplanation {
  const revisions =
    candidate === undefined
      ? {}
      : {
          nodeObservationRevision: candidate.snapshot.nodeObservationRevision,
          reservationLedgerRevision: candidate.reservationLedgerRevision,
          capabilityRevision: candidate.capabilityRevision,
        };
  return Object.freeze({
    admissionPolicyRevision: policy.revision,
    attemptId: workload.attemptId,
    details: Object.freeze([...details]),
    evaluatedAt: now,
    fairnessRevision: fairness.fairnessRevision,
    outcome,
    reason,
    ...revisions,
  });
}

function tenantDominantShare(
  tenantId: string,
  policy: TenantFairnessPolicy,
  fairness: FairnessChargeSnapshot,
  capacity: ResourceAmounts,
  dimensions: readonly string[],
  poolId: string,
): number {
  const charge = fairness.poolTenantResources[poolTenantKey(poolId, tenantId)];
  const shares = dimensions
    .filter((dimension) => amount(capacity, dimension) > 0)
    .map(
      (dimension) => amount(charge, dimension) / amount(capacity, dimension),
    );
  return Math.max(0, ...shares) / policy.weight;
}

function classDominantShare(
  workload: QueuedWorkload,
  policy: WorkloadClassPolicy,
  fairness: FairnessChargeSnapshot,
  capacity: ResourceAmounts,
  dimensions: readonly string[],
  poolId: string,
): number {
  const charge = fairness.poolClassResources[poolClassKey(poolId, workload)];
  const shares = dimensions
    .filter((dimension) => amount(capacity, dimension) > 0)
    .map(
      (dimension) => amount(charge, dimension) / amount(capacity, dimension),
    );
  return Math.max(0, ...shares) / policy.weight;
}

function effectivePriority(
  workload: QueuedWorkload,
  policy: AdmissionPolicy,
  now: number,
): number {
  const ageBoost = Math.min(
    policy.maxAgingBoost,
    Math.floor(Math.max(0, now - workload.enqueuedAt) / policy.agingIntervalMs),
  );
  const deadlineBoost =
    workload.deadlineAt !== undefined &&
    workload.deadlineAt - now <= policy.deadlineBoostWindowMs
      ? policy.maxAgingBoost
      : 0;
  return workload.priority + ageBoost + deadlineBoost;
}

function compatibleCandidates(
  workload: QueuedWorkload,
  candidates: readonly AdmissionCapacityCandidate[],
): readonly AdmissionCapacityCandidate[] {
  return candidates.filter(
    (candidate) =>
      workload.compatiblePoolIds.includes(candidate.snapshot.poolId) &&
      workload.requiredCapabilities.every((capability) =>
        candidate.capabilities.includes(capability),
      ),
  );
}

function quotaReason(
  workload: QueuedWorkload,
  tenant: TenantFairnessPolicy,
  classPolicy: WorkloadClassPolicy,
  fairness: FairnessChargeSnapshot,
): AdmissionReasonCode | undefined {
  if (
    (fairness.tenantConcurrent[workload.tenantId] ?? 0) >= tenant.maxConcurrent
  )
    return "tenant_concurrency_quota";
  if (
    exceeds(
      fairness.tenantResources[workload.tenantId],
      workload.resources,
      tenant.resourceQuota,
    )
  )
    return "tenant_resource_quota";
  const key = classKey(workload);
  if ((fairness.classConcurrent[key] ?? 0) >= classPolicy.maxConcurrent)
    return "class_concurrency_quota";
  if (
    exceeds(
      fairness.classResources[key],
      workload.resources,
      classPolicy.resourceQuota,
    )
  )
    return "class_resource_quota";
  return undefined;
}

export function selectFairAdmission(
  input: Readonly<{
    queue: readonly QueuedWorkload[];
    candidates: readonly AdmissionCapacityCandidate[];
    policy: AdmissionPolicy;
    fairness: FairnessChargeSnapshot;
    safety: SafetyBoundDecision;
    now: number;
  }>,
): AdmissionSelection {
  validateAdmissionPolicy(input.policy);
  const explanations: AdmissionExplanation[] = [];
  const eligible: {
    workload: QueuedWorkload;
    candidate: AdmissionCapacityCandidate;
    tenantScore: number;
    classScore: number;
    priority: number;
  }[] = [];
  let reservedWorkload: QueuedWorkload | undefined;

  for (const workload of input.queue) {
    const tenant = input.policy.tenants[workload.tenantId];
    if (!validResourceRequest(workload.resources)) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "invalid_resource_request",
        ),
      );
      continue;
    }
    if (workload.deadlineAt !== undefined && workload.deadlineAt <= input.now) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "deadline_elapsed",
        ),
      );
      continue;
    }
    if (input.safety.status === "closed") {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "defer",
          "hard_safety_bound",
          input.safety.reasons,
        ),
      );
      continue;
    }
    if (tenant === undefined) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "tenant_unknown",
        ),
      );
      continue;
    }
    const classPolicy = tenant.classes[workload.workloadClass];
    if (classPolicy === undefined) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "class_unknown",
        ),
      );
      continue;
    }
    const poolCandidates = input.candidates.filter((candidate) =>
      workload.compatiblePoolIds.includes(candidate.snapshot.poolId),
    );
    const compatible = compatibleCandidates(workload, input.candidates);
    if (compatible.length === 0) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "missing_capability",
        ),
      );
      continue;
    }
    if (
      !compatible.some((candidate) =>
        fits(workload.resources, candidate.maximumEnvelope),
      )
    ) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "reject",
          "permanently_unschedulable",
        ),
      );
      continue;
    }
    const quota = quotaReason(workload, tenant, classPolicy, input.fairness);
    if (quota !== undefined) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "defer",
          quota,
        ),
      );
      continue;
    }
    const open = compatible.filter(
      (candidate) =>
        !candidate.snapshot.status.startsWith("closed_") &&
        !(
          workload.lane === "producer" &&
          candidate.snapshot.status === "producer_paused"
        ),
    );
    if (open.length === 0) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "defer",
          "pressure_closed",
          poolCandidates.flatMap((candidate) => candidate.snapshot.reasons),
        ),
      );
      continue;
    }
    const fitting = open.filter((candidate) =>
      fits(
        workload.resources,
        workload.lane === "recovery"
          ? candidate.recoveryAvailable
          : candidate.producerAvailable,
      ),
    );
    const reservationDue =
      workload.bypassCount >= input.policy.maxBypassCount ||
      input.now - workload.enqueuedAt >= input.policy.maxQueueAgeMs;
    if (
      reservationDue &&
      (reservedWorkload === undefined ||
        workload.enqueuedAt < reservedWorkload.enqueuedAt ||
        (workload.enqueuedAt === reservedWorkload.enqueuedAt &&
          workload.attemptId.localeCompare(reservedWorkload.attemptId) < 0))
    ) {
      reservedWorkload = workload;
    }
    if (fitting.length === 0) {
      explanations.push(
        explanation(
          workload,
          input.policy,
          input.fairness,
          input.now,
          "defer",
          reservationDue ? "large_workload_reserved" : "capacity_unavailable",
        ),
      );
      continue;
    }
    const candidate = [...fitting].sort((a, b) =>
      a.snapshot.nodeId.localeCompare(b.snapshot.nodeId),
    )[0];
    if (candidate === undefined) continue;
    eligible.push({
      candidate,
      classScore: classDominantShare(
        workload,
        classPolicy,
        input.fairness,
        candidate.snapshot.effective,
        candidate.fairnessDimensions,
        candidate.snapshot.poolId,
      ),
      priority: effectivePriority(workload, input.policy, input.now),
      tenantScore: tenantDominantShare(
        workload.tenantId,
        tenant,
        input.fairness,
        candidate.snapshot.effective,
        candidate.fairnessDimensions,
        candidate.snapshot.poolId,
      ),
      workload,
    });
  }

  const selected = eligible
    .filter(
      (entry) =>
        reservedWorkload === undefined ||
        entry.workload.attemptId === reservedWorkload.attemptId,
    )
    .sort(
      (a, b) =>
        Number(b.workload.lane === "recovery") -
          Number(a.workload.lane === "recovery") ||
        a.tenantScore - b.tenantScore ||
        a.classScore - b.classScore ||
        b.priority - a.priority ||
        a.workload.enqueuedAt - b.workload.enqueuedAt ||
        a.workload.attemptId.localeCompare(b.workload.attemptId),
    )[0];

  if (selected === undefined) {
    return Object.freeze({
      explanations: Object.freeze(explanations),
      ...(reservedWorkload === undefined
        ? {}
        : { reservedAttemptId: reservedWorkload.attemptId }),
    });
  }
  const admitted = explanation(
    selected.workload,
    input.policy,
    input.fairness,
    input.now,
    "admit",
    "admissible",
    [],
    selected.candidate,
  );
  return Object.freeze({
    explanations: Object.freeze([...explanations, admitted]),
    plan: Object.freeze({
      candidate: selected.candidate,
      expectedFairnessRevision: input.fairness.fairnessRevision,
      explanation: admitted,
      workload: selected.workload,
    }),
  });
}
