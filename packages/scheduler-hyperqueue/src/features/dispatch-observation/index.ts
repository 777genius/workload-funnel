import { createHash } from "node:crypto";

import type { DispatchEvidence } from "@workload-funnel/workload-control/dispatch-reconciliation";

export interface HyperQueueReadExecutor {
  executeRead(
    args: readonly string[],
    limits: HyperQueueReadLimits,
  ): Promise<string>;
  verifyExactVersion(
    expectedOutput: string,
    limits: HyperQueueReadLimits,
  ): Promise<void>;
}

export interface HyperQueueReadLimits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface HyperQueueObservationOrder {
  readonly durability: string;
  next(
    source: string,
  ): Promise<Readonly<{ sourceEpoch: number; sourceSequence: number }>>;
}

export interface HyperQueueDispatchMapping {
  readonly jobId: string;
  readonly mappingFingerprint: string;
  readonly taskId: string;
}

export interface HyperQueueDispatchObservation {
  readonly dispatchEvidence: DispatchEvidence;
  readonly exitCode: number | null;
  readonly schedulerState:
    | "waiting"
    | "running"
    | "finished"
    | "failed"
    | "canceled"
    | "lost"
    | "unknown";
  readonly workerId: string | null;
}

interface JsonRecord {
  readonly [key: string]: unknown;
  readonly id?: unknown;
  readonly info?: unknown;
  readonly tasks?: unknown;
  readonly exitCode?: unknown;
  readonly exit_code?: unknown;
  readonly state?: unknown;
  readonly worker?: unknown;
  readonly worker_id?: unknown;
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_observation_schema_invalid");
  return value as JsonRecord;
}

function identifier(value: unknown): string;
function identifier(value: unknown, nullable: true): string | null;
function identifier(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    throw new Error("hyperqueue_observation_schema_invalid");
  return value;
}

function numericIdentifier(value: unknown): string {
  if (Number.isSafeInteger(value) && (value as number) >= 0)
    return String(value);
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value))
    throw new Error("hyperqueue_observation_schema_invalid");
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric))
    throw new Error("hyperqueue_observation_schema_invalid");
  return value;
}

function schedulerState(
  value: unknown,
): HyperQueueDispatchObservation["schedulerState"] {
  if (typeof value !== "string")
    throw new Error("hyperqueue_observation_schema_invalid");
  const normalized = value.toLowerCase();
  if (normalized === "queued") return "waiting";
  if (
    normalized === "waiting" ||
    normalized === "running" ||
    normalized === "finished" ||
    normalized === "failed" ||
    normalized === "canceled" ||
    normalized === "lost"
  )
    return normalized;
  return "unknown";
}

export function parseHyperQueueObservation(
  output: string,
  mapping: HyperQueueDispatchMapping,
  order: Readonly<{ sourceEpoch: number; sourceSequence: number }>,
): HyperQueueDispatchObservation {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_observation_malformed");
  }
  if (!Array.isArray(decoded) || decoded.length !== 1)
    throw new Error("hyperqueue_observation_schema_invalid");
  const job = record(decoded[0]);
  if (Object.hasOwn(job, "id"))
    throw new Error("hyperqueue_observation_schema_invalid");
  const info = record(job.info);
  const jobId = numericIdentifier(info.id);
  if (!Array.isArray(job.tasks))
    throw new Error("hyperqueue_observation_schema_invalid");
  const tasks = job.tasks
    .map(record)
    .filter((task) => numericIdentifier(task.id) === mapping.taskId);
  if (tasks.length !== 1)
    throw new Error("hyperqueue_observation_schema_invalid");
  const value = tasks.at(0);
  if (value === undefined)
    throw new Error("hyperqueue_observation_schema_invalid");
  if (
    jobId !== mapping.jobId ||
    !Number.isSafeInteger(order.sourceEpoch) ||
    order.sourceEpoch < 1 ||
    !Number.isSafeInteger(order.sourceSequence) ||
    order.sourceSequence < 1
  )
    throw new Error("hyperqueue_observation_schema_invalid");
  const state = schedulerState(value.state);
  const exitCode = value.exit_code ?? value.exitCode ?? null;
  if (exitCode !== null && !Number.isSafeInteger(exitCode))
    throw new Error("hyperqueue_observation_schema_invalid");
  const worker = value.worker_id ?? value.worker ?? null;
  const workerId =
    worker === null
      ? null
      : typeof worker === "number" && Number.isSafeInteger(worker)
        ? String(worker)
        : identifier(worker, true);
  const observed =
    state === "waiting"
      ? "accepted"
      : state === "running"
        ? "running"
        : ["finished", "failed", "canceled"].includes(state)
          ? "terminal"
          : "reconciliation_required";
  return Object.freeze({
    dispatchEvidence: Object.freeze({
      complete: !["lost", "unknown"].includes(state),
      digest: `sha256:${createHash("sha256").update(output, "utf8").digest("hex")}`,
      kind: "adapter_lookup",
      observed,
      source: "scheduler-hyperqueue",
      sourceEpoch: order.sourceEpoch,
      sourceSequence: order.sourceSequence,
    }),
    exitCode: exitCode as number | null,
    schedulerState: state,
    workerId,
  });
}

export interface HyperQueueDispatchObserver {
  readonly observationOrderDurability: "restart_durable";
  initialize(): Promise<void>;
  observe(
    mapping: HyperQueueDispatchMapping,
  ): Promise<HyperQueueDispatchObservation>;
}

export function createProvider(
  executor: HyperQueueReadExecutor,
  exactVersion: string,
  limits: HyperQueueReadLimits,
  order: HyperQueueObservationOrder,
): HyperQueueDispatchObserver {
  if (
    !Number.isSafeInteger(limits.maxOutputBytes) ||
    limits.maxOutputBytes < 1 ||
    limits.maxOutputBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.timeoutMs) ||
    limits.timeoutMs < 1 ||
    limits.timeoutMs > 60_000
  )
    throw new Error("hyperqueue_read_limits_invalid");
  if (order.durability !== "restart_durable")
    throw new Error("hyperqueue_observation_order_not_durable");
  return Object.freeze({
    initialize: () => executor.verifyExactVersion(`hq ${exactVersion}`, limits),
    observationOrderDurability: "restart_durable" as const,
    async observe(mapping: HyperQueueDispatchMapping) {
      const output = await executor.executeRead(
        ["job", "info", mapping.jobId, "--output-mode", "json"],
        limits,
      );
      if (Buffer.byteLength(output) > limits.maxOutputBytes)
        throw new Error("hyperqueue_observation_output_limit_exceeded");
      return parseHyperQueueObservation(
        output,
        mapping,
        await order.next("dispatch-observation"),
      );
    },
  });
}

export { FilesystemHyperQueueObservationOrder } from "./filesystem-observation-order.js";
