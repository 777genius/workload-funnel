import { SCHEDULER_SHIM_PROTOCOL } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import type { DispatchEvidence } from "@workload-funnel/workload-control/dispatch-reconciliation";

export interface HyperQueueWorkerInventoryExecutor {
  executeRead(
    args: readonly string[],
    limits: HyperQueueWorkerInventoryLimits,
  ): Promise<string>;
}

export interface HyperQueueWorkerInventoryLimits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface SchedulerWorkerInventoryItem {
  readonly customResources: Readonly<Record<string, number>>;
  readonly state: "idle" | "running" | "offline";
  readonly workerId: string;
}

export interface SchedulerInventory {
  readonly evidence: DispatchEvidence;
  readonly shimProtocol: typeof SCHEDULER_SHIM_PROTOCOL;
  readonly workers: readonly SchedulerWorkerInventoryItem[];
}

interface UntrustedWorker {
  readonly [key: string]: unknown;
  readonly customResources?: unknown;
  readonly state?: unknown;
  readonly workerId?: unknown;
}

interface UntrustedInventory {
  readonly [key: string]: unknown;
  readonly schemaVersion?: unknown;
  readonly shimProtocol?: unknown;
  readonly sourceEpoch?: unknown;
  readonly sourceSequence?: unknown;
  readonly workers?: unknown;
}

function parseWorker(value: unknown): SchedulerWorkerInventoryItem {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_worker_schema_invalid");
  const worker = value as UntrustedWorker;
  if (
    Object.keys(worker).sort().join() !==
      ["customResources", "state", "workerId"].sort().join() ||
    typeof worker.workerId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(worker.workerId) ||
    (worker.state !== "idle" &&
      worker.state !== "running" &&
      worker.state !== "offline") ||
    typeof worker.customResources !== "object" ||
    worker.customResources === null ||
    Array.isArray(worker.customResources)
  )
    throw new Error("hyperqueue_worker_schema_invalid");
  const resources = worker.customResources as Readonly<Record<string, unknown>>;
  if (
    Object.entries(resources).some(
      ([key, amount]) =>
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key) ||
        !Number.isSafeInteger(amount) ||
        (amount as number) < 0,
    )
  )
    throw new Error("hyperqueue_worker_schema_invalid");
  return Object.freeze({
    customResources: Object.freeze(
      resources as Readonly<Record<string, number>>,
    ),
    state: worker.state,
    workerId: worker.workerId,
  });
}

export function parseHyperQueueWorkerInventory(
  output: string,
): SchedulerInventory {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_worker_inventory_malformed");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
    throw new Error("hyperqueue_worker_schema_invalid");
  const value = decoded as UntrustedInventory;
  if (
    Object.keys(value).sort().join() !==
      [
        "schemaVersion",
        "shimProtocol",
        "sourceEpoch",
        "sourceSequence",
        "workers",
      ]
        .sort()
        .join() ||
    value.schemaVersion !== 1 ||
    value.shimProtocol !== SCHEDULER_SHIM_PROTOCOL ||
    !Number.isSafeInteger(value.sourceEpoch) ||
    (value.sourceEpoch as number) < 1 ||
    !Number.isSafeInteger(value.sourceSequence) ||
    (value.sourceSequence as number) < 1 ||
    !Array.isArray(value.workers)
  )
    throw new Error("hyperqueue_worker_schema_invalid");
  return Object.freeze({
    evidence: Object.freeze({
      complete: true,
      digest: `worker-inventory:${String(value.sourceEpoch)}:${String(value.sourceSequence)}`,
      kind: "scheduler_event",
      observed: "accepted",
      source: "scheduler-hyperqueue-workers",
      sourceEpoch: value.sourceEpoch as number,
      sourceSequence: value.sourceSequence as number,
    }),
    shimProtocol: SCHEDULER_SHIM_PROTOCOL,
    workers: Object.freeze(value.workers.map(parseWorker)),
  });
}

export function createProvider(
  executor: HyperQueueWorkerInventoryExecutor,
  limits: HyperQueueWorkerInventoryLimits,
) {
  if (
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes < 1 ||
    limits.maxOutputBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    limits.timeoutMs > 60_000
  )
    throw new Error("hyperqueue_worker_inventory_limits_invalid");
  return Object.freeze({
    async inventory(): Promise<SchedulerInventory> {
      const output = await executor.executeRead(
        ["worker", "list", "--output-mode", "json"],
        limits,
      );
      if (Buffer.byteLength(output) > limits.maxOutputBytes)
        throw new Error("hyperqueue_worker_inventory_output_limit_exceeded");
      return parseHyperQueueWorkerInventory(output);
    },
  });
}
