import { createHash } from "node:crypto";

import type { MutationFence } from "@workload-funnel/kernel";
import type {
  SchedulerAuthorityHighWatermarks,
  SchedulerMutationScope,
  SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

import type { GatewayWal } from "./gateway-wal.js";
import type { ScopeSerializer } from "./scope-serializer.js";

export interface ScopeState {
  acknowledgement?: SignedSchedulerFenceInstallAcknowledgement;
  closed: boolean;
  cordonReason?: string;
  fence?: MutationFence;
  fingerprint?: string;
  invalidatedByCrossScope: boolean;
  registrySequence: number;
  scope?: SchedulerMutationScope;
  startupRevalidationRequired: boolean;
}

export interface GatewayRegistryRuntime {
  readonly acknowledgementKey: Uint8Array;
  readonly assertHealthy: () => void;
  readonly authorityRevalidationRequired: () => boolean;
  readonly authorityId: string;
  readonly closing: Set<string>;
  readonly highWatermarks: SchedulerAuthorityHighWatermarks;
  readonly nowMs: () => number;
  readonly scopes: Map<string, ScopeState>;
  readonly serializer: ScopeSerializer;
  readonly trustedInstallKeys: ReadonlyMap<string, Uint8Array>;
  readonly wal: GatewayWal;
}

export interface DurableOperationResult<T> {
  readonly requestFingerprint: string;
  readonly result: T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function scopeState(
  runtime: GatewayRegistryRuntime,
  key: string,
): ScopeState {
  const state = runtime.scopes.get(key) ?? {
    closed: true,
    invalidatedByCrossScope: false,
    registrySequence: 0,
    startupRevalidationRequired: false,
  };
  runtime.scopes.set(key, state);
  return state;
}

export function runSerialized<T>(
  runtime: GatewayRegistryRuntime,
  keys: readonly string[],
  work: () => Promise<T> | T,
): Promise<T> {
  const ordered = [...new Set(keys)].sort((left, right) =>
    Buffer.from(left).compare(Buffer.from(right)),
  );
  const serialize = (index: number): Promise<T> => {
    const key = ordered[index];
    if (key === undefined) return Promise.resolve(work());
    return runtime.serializer.run(key, () => serialize(index + 1));
  };
  return serialize(0);
}
