import { SCHEDULER_SHIM_PROTOCOL } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import type { DispatchEvidence } from "@workload-funnel/workload-control/dispatch-reconciliation";
import { createHash } from "node:crypto";

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

export interface HyperQueueWorkerInventoryOrder {
  readonly durability: string;
  next(
    source: string,
  ): Promise<Readonly<{ sourceEpoch: number; sourceSequence: number }>>;
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
  readonly custom_resources?: unknown;
  readonly id?: unknown;
  readonly resources?: unknown;
  readonly state?: unknown;
}

function parseWorker(value: unknown): SchedulerWorkerInventoryItem {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_worker_schema_invalid");
  const worker = value as UntrustedWorker;
  const workerId = Number.isSafeInteger(worker.id)
    ? String(worker.id)
    : worker.id;
  const rawState =
    typeof worker.state === "string" ? worker.state.toLowerCase() : undefined;
  const state =
    rawState === "running"
      ? "running"
      : rawState === "idle"
        ? "idle"
        : rawState === "offline" || rawState === "stopped"
          ? "offline"
          : undefined;
  const resourceValue = worker.custom_resources ?? worker.resources ?? {};
  if (
    typeof workerId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workerId) ||
    state === undefined ||
    typeof resourceValue !== "object" ||
    Array.isArray(resourceValue)
  )
    throw new Error("hyperqueue_worker_schema_invalid");
  const resources = resourceValue as Readonly<Record<string, unknown>>;
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
    state,
    workerId,
  });
}

export function parseHyperQueueWorkerInventory(
  output: string,
  order: Readonly<{ sourceEpoch: number; sourceSequence: number }>,
): SchedulerInventory {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_worker_inventory_malformed");
  }
  if (
    !Array.isArray(decoded) ||
    !Number.isSafeInteger(order.sourceEpoch) ||
    order.sourceEpoch < 1 ||
    !Number.isSafeInteger(order.sourceSequence) ||
    order.sourceSequence < 1
  )
    throw new Error("hyperqueue_worker_schema_invalid");
  return Object.freeze({
    evidence: Object.freeze({
      complete: true,
      digest: `sha256:${createHash("sha256").update(output, "utf8").digest("hex")}`,
      kind: "scheduler_event",
      observed: "accepted",
      source: "scheduler-hyperqueue-workers",
      sourceEpoch: order.sourceEpoch,
      sourceSequence: order.sourceSequence,
    }),
    shimProtocol: SCHEDULER_SHIM_PROTOCOL,
    workers: Object.freeze(decoded.map(parseWorker)),
  });
}

export function createProvider(
  executor: HyperQueueWorkerInventoryExecutor,
  limits: HyperQueueWorkerInventoryLimits,
  order: HyperQueueWorkerInventoryOrder,
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
  if (order.durability !== "restart_durable")
    throw new Error("hyperqueue_worker_inventory_order_not_durable");
  return Object.freeze({
    async inventory(): Promise<SchedulerInventory> {
      const output = await executor.executeRead(
        ["worker", "list", "--output-mode", "json"],
        limits,
      );
      if (Buffer.byteLength(output) > limits.maxOutputBytes)
        throw new Error("hyperqueue_worker_inventory_output_limit_exceeded");
      return parseHyperQueueWorkerInventory(
        output,
        await order.next("worker-inventory"),
      );
    },
  });
}
