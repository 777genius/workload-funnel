import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import { SCHEDULER_SHIM_PROTOCOL } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import type {
  AuthorizedHyperQueueMutation,
  HyperQueueMutation,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

export interface HyperQueueCliLimits {
  readonly maxOutputBytes: number;
  readonly timeoutMs: number;
}

export interface HyperQueueCliExecution {
  readonly stderr: string;
  readonly stdout: string;
}

export interface CredentialedHyperQueueExecutor {
  executeMutation(
    args: readonly string[],
    limits: HyperQueueCliLimits,
  ): Promise<HyperQueueCliExecution>;
  verifyRelease(
    expectedVersionOutput: string,
    expectedBinarySha256: string,
    limits: HyperQueueCliLimits,
  ): Promise<void>;
}

export interface HyperQueueCliMutationResult {
  readonly externalReference: string;
  readonly jobId: string;
  readonly mappingFingerprint: string;
  readonly state: "accepted" | "canceled";
  readonly taskId: string;
}

interface JsonRecord {
  readonly [key: string]: unknown;
  readonly jobId?: unknown;
  readonly mappingFingerprint?: unknown;
  readonly schemaVersion?: unknown;
  readonly state?: unknown;
  readonly taskId?: unknown;
}

function record(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("hyperqueue_cli_schema_invalid");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, keys: readonly string[]): void {
  if (Object.keys(value).sort().join() !== [...keys].sort().join())
    throw new Error("hyperqueue_cli_schema_invalid");
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  )
    throw new Error("hyperqueue_cli_schema_invalid");
  return value;
}

function parseMutationOutput(
  output: string,
  mutation: HyperQueueMutation,
): HyperQueueCliMutationResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output) as unknown;
  } catch {
    throw new Error("hyperqueue_cli_output_malformed");
  }
  const value = record(decoded);
  exactKeys(value, [
    "jobId",
    "mappingFingerprint",
    "schemaVersion",
    "state",
    "taskId",
  ]);
  if (value.schemaVersion !== 1)
    throw new Error("hyperqueue_cli_schema_unsupported");
  const jobId = identifier(value.jobId);
  const taskId = identifier(value.taskId);
  const mappingFingerprint = identifier(value.mappingFingerprint);
  if (
    mappingFingerprint !== mutation.mappingFingerprint ||
    (mutation.kind === "cancel" &&
      (mutation.jobId !== jobId || mutation.taskId !== taskId))
  )
    throw new Error("hyperqueue_cli_mapping_mismatch");
  const expectedState = mutation.kind === "submit" ? "accepted" : "canceled";
  if (value.state !== expectedState)
    throw new Error("hyperqueue_cli_state_invalid");
  return Object.freeze({
    externalReference: `hq://${jobId}/${taskId}`,
    jobId,
    mappingFingerprint,
    state: expectedState,
    taskId,
  });
}

function encodedShim(value: string): string {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength < 1 || decoded.byteLength > 256 * 1024)
    throw new Error("hyperqueue_shim_payload_invalid");
  return value;
}

function submitArguments(
  mutation: Extract<HyperQueueMutation, { readonly kind: "submit" }>,
  shimExecutable: string,
): readonly string[] {
  const args = [
    "job",
    "submit",
    "--output-mode",
    "json",
    "--no-progress",
    "--name",
    mutation.jobName,
    "--max-fails",
    "0",
    "--cpus",
    String(mutation.requestedCpuCount),
  ];
  for (const [key, value] of Object.entries(
    mutation.requiredCustomResources,
  ).sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))) {
    args.push("--resource", `${key}=${String(value)}`);
  }
  args.push(
    "--",
    shimExecutable,
    "--protocol",
    SCHEDULER_SHIM_PROTOCOL,
    "--invocation-base64",
    encodedShim(mutation.shimInvocationBase64),
    "--restart-policy",
    mutation.restartPolicy,
    "--mapping-fingerprint",
    mutation.mappingFingerprint,
  );
  return Object.freeze(args);
}

function cancelArguments(
  mutation: Extract<HyperQueueMutation, { readonly kind: "cancel" }>,
): readonly string[] {
  return Object.freeze([
    "job",
    "cancel",
    mutation.jobId,
    "--task",
    mutation.taskId,
    "--output-mode",
    "json",
    "--mapping-fingerprint",
    mutation.mappingFingerprint,
  ]);
}

export class ExactVersionHyperQueueCliMutation {
  #verified = false;

  public constructor(
    private readonly config: Readonly<{
      exactVersion: string;
      expectedBinarySha256: string;
      executor: CredentialedHyperQueueExecutor;
      limits: HyperQueueCliLimits;
      shimExecutable: string;
    }>,
  ) {
    if (
      !Number.isSafeInteger(config.limits.maxOutputBytes) ||
      config.limits.maxOutputBytes < 1 ||
      config.limits.maxOutputBytes > 2 * 1024 * 1024 ||
      !Number.isSafeInteger(config.limits.timeoutMs) ||
      config.limits.timeoutMs < 1 ||
      config.limits.timeoutMs > 60_000 ||
      !config.shimExecutable.startsWith("/") ||
      config.shimExecutable.length > 4_096 ||
      config.shimExecutable.includes("\u0000")
    )
      throw new Error("hyperqueue_cli_configuration_invalid");
  }

  public get verified(): boolean {
    return this.#verified;
  }

  public async verifyExactRelease(): Promise<void> {
    if (!/^\d+\.\d+\.\d+$/u.test(this.config.exactVersion))
      throw new Error("hyperqueue_exact_version_invalid");
    if (!/^[a-f0-9]{64}$/u.test(this.config.expectedBinarySha256))
      throw new Error("hyperqueue_binary_checksum_invalid");
    await this.config.executor.verifyRelease(
      `hq ${this.config.exactVersion}`,
      this.config.expectedBinarySha256,
      this.config.limits,
    );
    this.#verified = true;
  }

  public async mutate(
    authorized: AuthorizedHyperQueueMutation,
  ): Promise<HyperQueueCliMutationResult> {
    if (!this.#verified) throw new Error("hyperqueue_release_not_verified");
    const appliedFence: MutationFence = authorized.request.mutationFence;
    if (
      fingerprintMutationFence(appliedFence) !==
      authorized.request.mutationFenceFingerprint
    )
      throw new Error("hyperqueue_authorized_fence_mismatch");
    const mutation = authorized.request.payload;
    const args =
      mutation.kind === "submit"
        ? submitArguments(mutation, this.config.shimExecutable)
        : cancelArguments(mutation);
    const result = await this.config.executor.executeMutation(
      args,
      this.config.limits,
    );
    if (
      Buffer.byteLength(result.stdout) > this.config.limits.maxOutputBytes ||
      Buffer.byteLength(result.stderr) > this.config.limits.maxOutputBytes
    )
      throw new Error("hyperqueue_cli_output_limit_exceeded");
    return parseMutationOutput(result.stdout, mutation);
  }
}
