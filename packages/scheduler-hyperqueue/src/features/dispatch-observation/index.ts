import { SCHEDULER_SHIM_PROTOCOL } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
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
  readonly exitCode?: unknown;
  readonly jobId?: unknown;
  readonly mappingFingerprint?: unknown;
  readonly schemaVersion?: unknown;
  readonly shimProtocol?: unknown;
  readonly sourceEpoch?: unknown;
  readonly sourceSequence?: unknown;
  readonly state?: unknown;
  readonly taskId?: unknown;
  readonly workerId?: unknown;
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_observation_schema_invalid");
  return value as JsonRecord;
}

function identifier(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    throw new Error("hyperqueue_observation_schema_invalid");
  return value;
}

export function parseHyperQueueObservation(
  output: string,
  mapping: HyperQueueDispatchMapping,
): HyperQueueDispatchObservation {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_observation_malformed");
  }
  const value = record(decoded);
  const keys = [
    "exitCode",
    "jobId",
    "mappingFingerprint",
    "schemaVersion",
    "shimProtocol",
    "sourceEpoch",
    "sourceSequence",
    "state",
    "taskId",
    "workerId",
  ];
  if (Object.keys(value).sort().join() !== keys.sort().join())
    throw new Error("hyperqueue_observation_schema_invalid");
  const states = new Set([
    "waiting",
    "running",
    "finished",
    "failed",
    "canceled",
    "lost",
    "unknown",
  ]);
  const jobId = identifier(value.jobId);
  const taskId = identifier(value.taskId);
  const fingerprint = identifier(value.mappingFingerprint);
  if (
    value.schemaVersion !== 1 ||
    value.shimProtocol !== SCHEDULER_SHIM_PROTOCOL ||
    jobId !== mapping.jobId ||
    taskId !== mapping.taskId ||
    fingerprint !== mapping.mappingFingerprint ||
    typeof value.state !== "string" ||
    !states.has(value.state) ||
    !Number.isSafeInteger(value.sourceEpoch) ||
    (value.sourceEpoch as number) < 1 ||
    !Number.isSafeInteger(value.sourceSequence) ||
    (value.sourceSequence as number) < 1 ||
    (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))
  )
    throw new Error("hyperqueue_observation_schema_invalid");
  const state = value.state as HyperQueueDispatchObservation["schedulerState"];
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
      digest: `${mapping.mappingFingerprint}:${String(value.sourceEpoch)}:${String(value.sourceSequence)}:${state}`,
      kind: "adapter_lookup",
      observed,
      source: "scheduler-hyperqueue",
      sourceEpoch: value.sourceEpoch as number,
      sourceSequence: value.sourceSequence as number,
    }),
    exitCode: value.exitCode as number | null,
    schedulerState: state,
    workerId: identifier(value.workerId, true),
  });
}

export interface HyperQueueDispatchObserver {
  initialize(): Promise<void>;
  observe(
    mapping: HyperQueueDispatchMapping,
  ): Promise<HyperQueueDispatchObservation>;
}

export function createProvider(
  executor: HyperQueueReadExecutor,
  exactVersion: string,
  limits: HyperQueueReadLimits,
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
  return Object.freeze({
    initialize: () => executor.verifyExactVersion(`hq ${exactVersion}`, limits),
    async observe(mapping: HyperQueueDispatchMapping) {
      const output = await executor.executeRead(
        [
          "job",
          "info",
          mapping.jobId,
          "--task",
          mapping.taskId,
          "--output-mode",
          "json",
        ],
        limits,
      );
      if (Buffer.byteLength(output) > limits.maxOutputBytes)
        throw new Error("hyperqueue_observation_output_limit_exceeded");
      return parseHyperQueueObservation(output, mapping);
    },
  });
}
