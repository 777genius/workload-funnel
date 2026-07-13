import type { MutationFence } from "@workload-funnel/kernel";

import type { SchedulerMutationScope } from "../domain/gateway-contract.js";
import { schedulerMutationScopeKey } from "../domain/gateway-validation.js";

export type SchedulerAuthorityHighWatermarkComponent =
  | "allocation_owner"
  | "attempt_revocation"
  | "cluster"
  | "desired_effect"
  | "namespace"
  | "operation_gate"
  | "scheduler_instance";

export interface SchedulerAuthorityHighWatermarkRecord {
  readonly component: SchedulerAuthorityHighWatermarkComponent;
  readonly identity: string;
  readonly key: string;
  readonly version: number;
}

export interface SchedulerAuthorityHighWatermarks {
  readonly records: Map<string, SchedulerAuthorityHighWatermarkRecord>;
}

export type SchedulerAuthorityHighWatermarkComparison =
  | "dominates"
  | "equal"
  | "equal_version_mismatch"
  | "lower"
  | "missing";

export interface SchedulerAuthorityHighWatermarkPlan {
  readonly comparison: Exclude<
    SchedulerAuthorityHighWatermarkComparison,
    "missing"
  >;
  readonly records: readonly SchedulerAuthorityHighWatermarkRecord[];
}

function tuple(...values: readonly string[]): string {
  return values.join("\u0000");
}

function storageKey(
  record: Pick<SchedulerAuthorityHighWatermarkRecord, "component" | "key">,
): string {
  return tuple(record.component, record.key);
}

function record(
  component: SchedulerAuthorityHighWatermarkComponent,
  key: string,
  version: number,
  identity: string,
): SchedulerAuthorityHighWatermarkRecord {
  return Object.freeze({ component, identity, key, version });
}

function identityMayChangeOnAdvance(
  component: SchedulerAuthorityHighWatermarkComponent,
): boolean {
  return (
    component === "cluster" ||
    component === "desired_effect" ||
    component === "scheduler_instance"
  );
}

export function schedulerAuthorityHighWatermarkRecords(
  fence: MutationFence,
  scope: SchedulerMutationScope,
): readonly SchedulerAuthorityHighWatermarkRecord[] {
  const records = [
    record(
      "cluster",
      "gateway",
      fence.clusterIncarnationVersion,
      fence.clusterIncarnation,
    ),
    record(
      "scheduler_instance",
      scope.schedulerInstanceId,
      fence.clusterIncarnationVersion,
      fence.clusterIncarnation,
    ),
    record(
      "namespace",
      fence.namespaceId,
      fence.namespaceWriterEpoch,
      fence.namespaceId,
    ),
    record(
      "operation_gate",
      tuple(scope.schedulerInstanceId, fence.namespaceId),
      fence.operationGateRevision,
      tuple(scope.schedulerInstanceId, fence.namespaceId),
    ),
    record(
      "desired_effect",
      tuple(
        scope.schedulerInstanceId,
        fence.namespaceId,
        scope.effectKind,
        fence.effectScopeKey,
      ),
      fence.expectedDesiredVersion,
      tuple(fence.desiredEffect, fence.supersessionKey),
    ),
  ];
  if (fence.allocationId !== undefined && fence.ownerFence !== undefined)
    records.push(
      record(
        "allocation_owner",
        fence.allocationId,
        fence.ownerFence,
        tuple(fence.allocationId, fence.attemptId, fence.executionGeneration),
      ),
    );
  if (
    fence.startFence !== undefined &&
    fence.issuedStartRevocationRevision !== undefined
  )
    records.push(
      record(
        "attempt_revocation",
        tuple(fence.namespaceId, fence.attemptId, fence.executionGeneration),
        fence.issuedStartRevocationRevision,
        fence.startFence,
      ),
    );
  return Object.freeze(
    records.sort((left, right) =>
      Buffer.from(storageKey(left)).compare(Buffer.from(storageKey(right))),
    ),
  );
}

export function createSchedulerAuthorityHighWatermarks(): SchedulerAuthorityHighWatermarks {
  return { records: new Map() };
}

export function planSchedulerAuthorityHighWatermarks(
  current: SchedulerAuthorityHighWatermarks,
  fence: MutationFence,
  scope: SchedulerMutationScope,
): SchedulerAuthorityHighWatermarkPlan {
  const candidates = schedulerAuthorityHighWatermarkRecords(fence, scope);
  let dominates = false;
  let mismatch = false;
  for (const candidate of candidates) {
    const installed = current.records.get(storageKey(candidate));
    if (installed === undefined) {
      dominates = true;
      continue;
    }
    if (candidate.version < installed.version)
      return Object.freeze({ comparison: "lower", records: candidates });
    if (
      candidate.identity !== installed.identity &&
      (candidate.version === installed.version ||
        !identityMayChangeOnAdvance(candidate.component))
    )
      mismatch = true;
    if (candidate.version > installed.version) dominates = true;
  }
  return Object.freeze({
    comparison: mismatch
      ? "equal_version_mismatch"
      : dominates
        ? "dominates"
        : "equal",
    records: candidates,
  });
}

export function compareSchedulerFenceToHighWatermarks(
  current: SchedulerAuthorityHighWatermarks,
  fence: MutationFence,
  scope: SchedulerMutationScope,
): SchedulerAuthorityHighWatermarkComparison {
  const plan = planSchedulerAuthorityHighWatermarks(current, fence, scope);
  if (
    plan.records.some(
      (candidate) => current.records.get(storageKey(candidate)) === undefined,
    )
  )
    return "missing";
  return plan.comparison;
}

export function applySchedulerAuthorityHighWatermarkPlan(
  current: SchedulerAuthorityHighWatermarks,
  plan: SchedulerAuthorityHighWatermarkPlan,
): void {
  if (
    plan.comparison === "lower" ||
    plan.comparison === "equal_version_mismatch"
  )
    throw new Error("scheduler_authority_high_watermark_plan_rejected");
  for (const candidate of plan.records)
    current.records.set(storageKey(candidate), candidate);
}

export function validateSchedulerAuthorityHighWatermarkRecords(
  actual: readonly SchedulerAuthorityHighWatermarkRecord[],
  expected: readonly SchedulerAuthorityHighWatermarkRecord[],
): void {
  if (
    JSON.stringify(actual) !== JSON.stringify(expected) ||
    actual.some(
      (item) =>
        !Number.isSafeInteger(item.version) ||
        item.version < 0 ||
        item.key.length === 0 ||
        item.identity.length === 0,
    )
  )
    throw new Error("scheduler_authority_high_watermark_record_invalid");
}

export function schedulerAuthoritySerializationKeys(
  fence: MutationFence,
  scope: SchedulerMutationScope,
): readonly string[] {
  return Object.freeze([
    schedulerMutationScopeKey(scope),
    ...schedulerAuthorityHighWatermarkRecords(fence, scope).map(
      (item) => `high-watermark\u0000${storageKey(item)}`,
    ),
  ]);
}
