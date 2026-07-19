import {
  canonicalHyperQueueOperationJobName,
  validateCanonicalHyperQueueOperationJobName,
  type HyperQueueSubmitOperationIdentity,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export {
  canonicalHyperQueueOperationJobName,
  validateCanonicalHyperQueueOperationJobName,
  type HyperQueueSubmitOperationIdentity,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export const HYPERQUEUE_OPERATION_LOOKUP_VERSION = "0.26.2" as const;

const canonicalJobNamePattern = /^wf-hq-v1-[A-Za-z0-9_-]{86}$/u;
const exactJobListRowKeys = [
  "cancel_reason",
  "id",
  "is_open",
  "name",
  "task_count",
  "task_stats",
] as const;
const exactTaskStatKeys = [
  "aborted",
  "canceled",
  "failed",
  "finished",
  "running",
  "waiting",
] as const;
const maxJobNameBytes = 255;
const maxCancelReasonBytes = 1_024;

export interface HyperQueueOperationLookupLimits {
  readonly maxOutputBytes: number;
  readonly maxRetainedJobs: number;
  readonly timeoutMs: number;
}

export interface HyperQueueOperationLookupExecution {
  readonly stderr: string;
  readonly stdout: string;
}

export interface HyperQueueOperationLookupExecutor {
  executeLookup(
    args: readonly string[],
    limits: HyperQueueOperationLookupLimits,
  ): Promise<HyperQueueOperationLookupExecution>;
}

export interface HyperQueueOperationLookupMatch {
  readonly jobId: string;
  readonly jobName: string;
  readonly taskId: "0";
}

export interface HyperQueueOperationLookupResult {
  readonly disposition: "zero" | "one" | "multiple";
  readonly matches: readonly HyperQueueOperationLookupMatch[];
  readonly outputBytes: number;
  readonly retainedJobCount: number;
}

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  return value as JsonRecord;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index])
  );
}

function canonicalJobId(value: unknown): string {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  return String(value);
}

function taskCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  return value as number;
}

function boundedNfcString(
  value: unknown,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > maxBytes ||
    value !== value.normalize("NFC")
  )
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  return value;
}

function validateTaskStats(value: unknown, expectedTaskCount: number): void {
  const taskStats = record(value);
  if (!hasExactKeys(taskStats, exactTaskStatKeys))
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  let total = 0;
  for (const key of exactTaskStatKeys) total += taskCount(taskStats[key]);
  if (total !== expectedTaskCount)
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
}

function validateJobListRow(value: unknown): Readonly<{
  id: string;
  isOpen: boolean;
  name: string;
  taskCount: number;
}> {
  const job = record(value);
  if (exactJobListRowKeys.some((key) => !Object.hasOwn(job, key)))
    throw new Error("hyperqueue_operation_lookup_incomplete");
  if (!hasExactKeys(job, exactJobListRowKeys))
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  const id = canonicalJobId(job["id"]);
  const count = taskCount(job["task_count"]);
  const isOpen = job["is_open"];
  if (typeof isOpen !== "boolean")
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  const name = boundedNfcString(job["name"], maxJobNameBytes, false);
  const cancelReason = job["cancel_reason"];
  if (cancelReason !== null)
    boundedNfcString(cancelReason, maxCancelReasonBytes, true);
  validateTaskStats(job["task_stats"], count);
  return Object.freeze({ id, isOpen, name, taskCount: count });
}

export function parseHyperQueueOperationLookup(
  output: string,
  expectedJobName: string,
): Omit<HyperQueueOperationLookupResult, "outputBytes"> {
  if (!canonicalJobNamePattern.test(expectedJobName))
    throw new Error("hyperqueue_operation_job_name_invalid");
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_operation_lookup_malformed");
  }
  if (!Array.isArray(decoded) || decoded.length > 100_000)
    throw new Error("hyperqueue_operation_lookup_schema_invalid");
  const seenJobIds = new Set<string>();
  const matches: HyperQueueOperationLookupMatch[] = [];
  for (const item of decoded) {
    const job = validateJobListRow(item);
    if (seenJobIds.has(job.id))
      throw new Error("hyperqueue_operation_lookup_schema_invalid");
    seenJobIds.add(job.id);
    if (job.name === expectedJobName) {
      if (job.isOpen || job.taskCount !== 1)
        throw new Error("hyperqueue_operation_lookup_schema_invalid");
      matches.push(
        Object.freeze({
          jobId: job.id,
          jobName: expectedJobName,
          taskId: "0",
        }),
      );
    }
  }
  return Object.freeze({
    disposition:
      matches.length === 0 ? "zero" : matches.length === 1 ? "one" : "multiple",
    matches: Object.freeze(matches),
    retainedJobCount: decoded.length,
  });
}

export class ExactVersionHyperQueueOperationLookup {
  private readonly limits: HyperQueueOperationLookupLimits;

  public constructor(
    private readonly executor: HyperQueueOperationLookupExecutor,
    config: Readonly<{
      readonly exactVersion: string;
      readonly limits: HyperQueueOperationLookupLimits;
    }>,
  ) {
    if (
      config.exactVersion !== HYPERQUEUE_OPERATION_LOOKUP_VERSION ||
      !Number.isSafeInteger(config.limits.maxOutputBytes) ||
      config.limits.maxOutputBytes < 1 ||
      config.limits.maxOutputBytes > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(config.limits.maxRetainedJobs) ||
      config.limits.maxRetainedJobs < 1 ||
      config.limits.maxRetainedJobs > 100_000 ||
      !Number.isSafeInteger(config.limits.timeoutMs) ||
      config.limits.timeoutMs < 1 ||
      config.limits.timeoutMs > 60_000
    )
      throw new Error("hyperqueue_operation_lookup_configuration_invalid");
    this.limits = Object.freeze({ ...config.limits });
  }

  public async lookup(
    identity: HyperQueueSubmitOperationIdentity,
  ): Promise<HyperQueueOperationLookupResult> {
    const jobName = canonicalHyperQueueOperationJobName(identity);
    validateCanonicalHyperQueueOperationJobName(identity, jobName);
    const result = await this.executor.executeLookup(
      ["job", "list", "--all", "--output-mode", "json"],
      this.limits,
    );
    const outputBytes =
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    if (outputBytes > this.limits.maxOutputBytes)
      throw new Error("hyperqueue_operation_lookup_output_limit_exceeded");
    if (result.stderr.length > 0)
      throw new Error("hyperqueue_operation_lookup_stderr");
    const parsed = parseHyperQueueOperationLookup(result.stdout, jobName);
    if (parsed.retainedJobCount > this.limits.maxRetainedJobs)
      throw new Error("hyperqueue_retained_history_ceiling_exceeded");
    return Object.freeze({ ...parsed, outputBytes });
  }

  public async assertSubmitCapacity(
    identity: HyperQueueSubmitOperationIdentity,
  ): Promise<HyperQueueOperationLookupResult> {
    const result = await this.lookup(identity);
    if (result.retainedJobCount >= this.limits.maxRetainedJobs)
      throw new Error("hyperqueue_retained_history_ceiling_reached");
    if (result.disposition !== "zero")
      throw new Error("hyperqueue_operation_job_name_collision");
    return result;
  }
}
