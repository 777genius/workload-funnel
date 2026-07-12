import type { ResourceAmounts } from "@workload-funnel/workload-control/capacity-management";

import type {
  AdmissionPolicy,
  FairnessChargeSnapshot,
  QueuedWorkload,
} from "./fair-admission.js";

export class StaleFairnessDecisionError extends Error {
  public constructor() {
    super("stale_fairness_revision");
    this.name = "StaleFairnessDecisionError";
  }
}

function key(workload: QueuedWorkload): string {
  return `${workload.tenantId}/${workload.workloadClass}`;
}

function poolTenantKey(poolId: string, tenantId: string): string {
  return `${poolId}/${tenantId}`;
}

function poolClassKey(poolId: string, workload: QueuedWorkload): string {
  return `${poolId}/${key(workload)}`;
}

function add(
  target: Map<string, Record<string, number>>,
  owner: string,
  resources: ResourceAmounts,
  direction: 1 | -1,
): void {
  const value = target.get(owner) ?? {};
  for (const [dimension, amount] of Object.entries(resources)) {
    value[dimension] = (value[dimension] ?? 0) + direction * amount;
    if (value[dimension] === 0) value[dimension] = 0;
    if ((value[dimension] ?? 0) < 0)
      throw new Error("negative_fairness_charge");
  }
  target.set(owner, value);
}

function asRecord(
  source: Map<string, Record<string, number>>,
): Readonly<Record<string, ResourceAmounts>> {
  return Object.freeze(
    Object.fromEntries(
      [...source.entries()].map(([owner, resources]) => [
        owner,
        Object.freeze({ ...resources }),
      ]),
    ),
  );
}

function counts(source: Map<string, number>): Readonly<Record<string, number>> {
  return Object.freeze(Object.fromEntries(source));
}

function wouldExceed(
  current: Record<string, number> | undefined,
  request: ResourceAmounts,
  quota: ResourceAmounts,
): boolean {
  return Object.entries(request).some(
    ([dimension, amount]) =>
      (current?.[dimension] ?? 0) + amount > (quota[dimension] ?? 0),
  );
}

function sameResources(
  first: ResourceAmounts,
  second: ResourceAmounts,
): boolean {
  const dimensions = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...dimensions].every(
    (dimension) => (first[dimension] ?? 0) === (second[dimension] ?? 0),
  );
}

export class SerializedFairnessLedger {
  #revision = 0;
  readonly #tenantResources = new Map<string, Record<string, number>>();
  readonly #classResources = new Map<string, Record<string, number>>();
  readonly #tenantConcurrent = new Map<string, number>();
  readonly #classConcurrent = new Map<string, number>();
  readonly #poolTenantResources = new Map<string, Record<string, number>>();
  readonly #poolClassResources = new Map<string, Record<string, number>>();
  readonly #active = new Map<
    string,
    Readonly<{ workload: QueuedWorkload; poolId: string }>
  >();

  public snapshot(): FairnessChargeSnapshot {
    return Object.freeze({
      classConcurrent: counts(this.#classConcurrent),
      classResources: asRecord(this.#classResources),
      fairnessRevision: this.#revision,
      poolClassResources: asRecord(this.#poolClassResources),
      poolTenantResources: asRecord(this.#poolTenantResources),
      tenantConcurrent: counts(this.#tenantConcurrent),
      tenantResources: asRecord(this.#tenantResources),
    });
  }

  public reserve(
    workload: QueuedWorkload,
    policy: AdmissionPolicy,
    expectedFairnessRevision: number,
    poolId: string,
  ): FairnessChargeSnapshot {
    const existing = this.#active.get(workload.attemptId);
    if (existing !== undefined) {
      this.assertReservable(workload, policy, expectedFairnessRevision, poolId);
      return this.snapshot();
    }
    this.assertReservable(workload, policy, expectedFairnessRevision, poolId);
    const tenant = policy.tenants[workload.tenantId];
    const workloadClass = tenant?.classes[workload.workloadClass];
    if (tenant === undefined || workloadClass === undefined)
      throw new Error("admission_policy_missing");
    const classId = key(workload);
    add(this.#tenantResources, workload.tenantId, workload.resources, 1);
    add(this.#classResources, classId, workload.resources, 1);
    add(
      this.#poolTenantResources,
      poolTenantKey(poolId, workload.tenantId),
      workload.resources,
      1,
    );
    add(
      this.#poolClassResources,
      poolClassKey(poolId, workload),
      workload.resources,
      1,
    );
    this.#tenantConcurrent.set(
      workload.tenantId,
      (this.#tenantConcurrent.get(workload.tenantId) ?? 0) + 1,
    );
    this.#classConcurrent.set(
      classId,
      (this.#classConcurrent.get(classId) ?? 0) + 1,
    );
    this.#active.set(workload.attemptId, Object.freeze({ poolId, workload }));
    this.#revision += 1;
    return this.snapshot();
  }

  public assertReservable(
    workload: QueuedWorkload,
    policy: AdmissionPolicy,
    expectedFairnessRevision: number,
    poolId: string,
  ): void {
    const existing = this.#active.get(workload.attemptId);
    if (existing !== undefined) {
      if (
        existing.workload.tenantId !== workload.tenantId ||
        existing.workload.workloadClass !== workload.workloadClass ||
        existing.poolId !== poolId ||
        !sameResources(existing.workload.resources, workload.resources)
      ) {
        throw new Error("fairness_charge_conflict");
      }
      return;
    }
    if (this.#revision !== expectedFairnessRevision) {
      throw new StaleFairnessDecisionError();
    }
    const tenant = policy.tenants[workload.tenantId];
    const workloadClass = tenant?.classes[workload.workloadClass];
    if (tenant === undefined || workloadClass === undefined)
      throw new Error("admission_policy_missing");
    const classId = key(workload);
    if (
      (this.#tenantConcurrent.get(workload.tenantId) ?? 0) >=
      tenant.maxConcurrent
    )
      throw new Error("tenant_concurrency_quota");
    if (
      (this.#classConcurrent.get(classId) ?? 0) >= workloadClass.maxConcurrent
    )
      throw new Error("class_concurrency_quota");
    if (
      wouldExceed(
        this.#tenantResources.get(workload.tenantId),
        workload.resources,
        tenant.resourceQuota,
      )
    )
      throw new Error("tenant_resource_quota");
    if (
      wouldExceed(
        this.#classResources.get(classId),
        workload.resources,
        workloadClass.resourceQuota,
      )
    )
      throw new Error("class_resource_quota");
  }

  public release(
    attemptId: string,
    expectedFairnessRevision: number,
  ): FairnessChargeSnapshot {
    if (this.#revision !== expectedFairnessRevision) {
      throw new StaleFairnessDecisionError();
    }
    const active = this.#active.get(attemptId);
    if (active === undefined) return this.snapshot();
    const { workload, poolId } = active;
    const classId = key(workload);
    add(this.#tenantResources, workload.tenantId, workload.resources, -1);
    add(this.#classResources, classId, workload.resources, -1);
    add(
      this.#poolTenantResources,
      poolTenantKey(poolId, workload.tenantId),
      workload.resources,
      -1,
    );
    add(
      this.#poolClassResources,
      poolClassKey(poolId, workload),
      workload.resources,
      -1,
    );
    this.#tenantConcurrent.set(
      workload.tenantId,
      (this.#tenantConcurrent.get(workload.tenantId) ?? 0) - 1,
    );
    this.#classConcurrent.set(
      classId,
      (this.#classConcurrent.get(classId) ?? 0) - 1,
    );
    this.#active.delete(attemptId);
    this.#revision += 1;
    return this.snapshot();
  }
}

export function recordQueueBypasses(
  queue: readonly QueuedWorkload[],
  admittedAttemptId: string,
): readonly QueuedWorkload[] {
  return Object.freeze(
    queue
      .filter((workload) => workload.attemptId !== admittedAttemptId)
      .map((workload) =>
        Object.freeze({ ...workload, bypassCount: workload.bypassCount + 1 }),
      ),
  );
}
