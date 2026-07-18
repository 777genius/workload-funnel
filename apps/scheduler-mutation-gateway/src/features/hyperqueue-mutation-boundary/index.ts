import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { GatewayAuthorityRegistry } from "@workload-funnel/scheduler-mutation-gateway/authority-registry";
import {
  ExactVersionHyperQueueCliMutation,
  type CredentialedHyperQueueExecutor,
  type HyperQueueCliExecution,
  type HyperQueueCliLimits,
  type HyperQueueCliMutationResult,
} from "@workload-funnel/scheduler-hyperqueue/hyperqueue-cli-mutation";
import {
  ExactVersionHyperQueueOperationLookup,
  validateCanonicalHyperQueueOperationJobName,
} from "@workload-funnel/scheduler-hyperqueue/operation-lookup";
import {
  GatewayContractError,
  snapshotMutationRequest,
  type AuthorizedHyperQueueMutation,
  type MutateHyperQueueRequest,
  type SchedulerMutationGatewayClient,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

const executeFile = promisify(execFile);

export interface GatewayCredentialConfig {
  readonly fixedExecutableArguments?: readonly string[];
  readonly hyperQueueExecutable: string;
  readonly mutationServerDirectory: string;
}

export interface GatewayCliReleaseConfig {
  readonly exactVersion: string;
  readonly expectedBinarySha256: string;
  readonly limits: HyperQueueCliLimits & {
    readonly maxRetainedJobs: number;
  };
  readonly shimExecutable: string;
}

export interface GatewayMutationFaults {
  afterCliCall?(): void;
  afterMappingPersist?(): void;
  beforeFinalValidationWait?(request: MutateHyperQueueRequest): Promise<void>;
}

export class SimulatedGatewayCrash extends Error {
  public constructor() {
    super("simulated_gateway_crash");
    this.name = "SimulatedGatewayCrash";
  }
}

class GatewayPreMutationRefusal extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "GatewayPreMutationRefusal";
  }
}

class GatewayCredentialedExecutor implements CredentialedHyperQueueExecutor {
  #schedulerDirectoryIdentity:
    | Readonly<{ device: number; inode: number }>
    | undefined;
  #verifiedExecutableIdentity:
    | Readonly<{
        device: number;
        inode: number;
        modifiedMs: number;
        size: number;
      }>
    | undefined;

  public constructor(private readonly config: GatewayCredentialConfig) {}

  public async executeMutation(
    args: readonly string[],
    limits: HyperQueueCliLimits,
  ): Promise<HyperQueueCliExecution> {
    this.assertCredentialCustody(true);
    this.assertExecutableIdentity();
    const result = await this.run(
      [
        ...(this.config.fixedExecutableArguments ?? []),
        "--server-dir",
        this.config.mutationServerDirectory,
        ...args,
      ],
      limits,
    );
    return Object.freeze(result);
  }

  public async executeLookup(
    args: readonly string[],
    limits: HyperQueueCliLimits,
  ): Promise<HyperQueueCliExecution> {
    return this.executeMutation(args, limits);
  }

  public async verifyRelease(
    expectedVersionOutput: string,
    expectedBinarySha256: string,
    limits: HyperQueueCliLimits,
  ): Promise<void> {
    this.assertCredentialCustody(false);
    const executable = this.trustedExecutableIdentity();
    const executableDigest = createHash("sha256")
      .update(readFileSync(this.config.hyperQueueExecutable))
      .digest("hex");
    if (executableDigest !== expectedBinarySha256)
      throw new Error("hyperqueue_binary_checksum_mismatch");
    this.assertSameExecutable(executable, this.trustedExecutableIdentity());
    this.#verifiedExecutableIdentity = executable;
    const result = await this.run(
      [...(this.config.fixedExecutableArguments ?? []), "--version"],
      limits,
    );
    if (
      result.stdout !== `${expectedVersionOutput}\n` ||
      result.stderr.length > 0
    )
      throw new Error("hyperqueue_exact_version_mismatch");
  }

  private assertCredentialCustody(requirePriorIdentity: boolean): void {
    const processUid = process.getuid?.();
    const identity = lstatSync(this.config.mutationServerDirectory);
    if (
      processUid === undefined ||
      !isAbsolute(this.config.mutationServerDirectory) ||
      !identity.isDirectory() ||
      identity.uid !== processUid ||
      (identity.mode & 0o077) !== 0
    )
      throw new GatewayPreMutationRefusal(
        "hyperqueue_credential_custody_unproven",
      );
    const current = { device: identity.dev, inode: identity.ino };
    if (
      requirePriorIdentity &&
      (this.#schedulerDirectoryIdentity === undefined ||
        this.#schedulerDirectoryIdentity.device !== current.device ||
        this.#schedulerDirectoryIdentity.inode !== current.inode)
    )
      throw new GatewayPreMutationRefusal(
        "hyperqueue_credential_custody_changed",
      );
    this.#schedulerDirectoryIdentity ??= Object.freeze(current);
  }

  private trustedExecutableIdentity(): Readonly<{
    device: number;
    inode: number;
    modifiedMs: number;
    size: number;
  }> {
    const identity = lstatSync(this.config.hyperQueueExecutable);
    if (
      !isAbsolute(this.config.hyperQueueExecutable) ||
      !identity.isFile() ||
      (identity.mode & 0o022) !== 0
    )
      throw new GatewayPreMutationRefusal(
        "hyperqueue_executable_identity_untrusted",
      );
    return Object.freeze({
      device: identity.dev,
      inode: identity.ino,
      modifiedMs: identity.mtimeMs,
      size: identity.size,
    });
  }

  private assertExecutableIdentity(): void {
    const expected = this.#verifiedExecutableIdentity;
    if (expected === undefined)
      throw new GatewayPreMutationRefusal("hyperqueue_release_not_verified");
    this.assertSameExecutable(expected, this.trustedExecutableIdentity());
  }

  private assertSameExecutable(
    expected: Readonly<{
      device: number;
      inode: number;
      modifiedMs: number;
      size: number;
    }>,
    actual: Readonly<{
      device: number;
      inode: number;
      modifiedMs: number;
      size: number;
    }>,
  ): void {
    if (
      expected.device !== actual.device ||
      expected.inode !== actual.inode ||
      expected.modifiedMs !== actual.modifiedMs ||
      expected.size !== actual.size
    )
      throw new GatewayPreMutationRefusal(
        "hyperqueue_executable_identity_changed",
      );
  }

  private async run(
    args: readonly string[],
    limits: HyperQueueCliLimits,
  ): Promise<HyperQueueCliExecution> {
    const result = await executeFile(
      this.config.hyperQueueExecutable,
      [...args],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        maxBuffer: limits.maxOutputBytes,
        shell: false,
        timeout: limits.timeoutMs,
      },
    );
    return { stderr: result.stderr, stdout: result.stdout };
  }
}

export class HyperQueueMutationBoundary implements Pick<
  SchedulerMutationGatewayClient,
  "mutate"
> {
  readonly #cli: ExactVersionHyperQueueCliMutation;
  readonly #lookup: ExactVersionHyperQueueOperationLookup;

  public constructor(
    private readonly registry: GatewayAuthorityRegistry,
    credential: GatewayCredentialConfig,
    release: GatewayCliReleaseConfig,
    private readonly faults: GatewayMutationFaults = {},
  ) {
    const executor = new GatewayCredentialedExecutor(credential);
    this.#cli = new ExactVersionHyperQueueCliMutation({
      exactVersion: release.exactVersion,
      executor,
      expectedBinarySha256: release.expectedBinarySha256,
      limits: release.limits,
      shimExecutable: release.shimExecutable,
    });
    this.#lookup = new ExactVersionHyperQueueOperationLookup(executor, {
      exactVersion: release.exactVersion,
      limits: release.limits,
    });
  }

  public get releaseVerified(): boolean {
    return this.#cli.verified;
  }

  public initialize(): Promise<void> {
    return this.#cli.verifyExactRelease();
  }

  public async mutate(request: MutateHyperQueueRequest) {
    const immutableRequest = snapshotMutationRequest(request);
    const replay = this.registry.replayReceipt(immutableRequest);
    if (replay !== undefined) return replay;
    if (!this.#cli.verified) throw new Error("hyperqueue_release_not_verified");
    const fence: MutationFence = immutableRequest.mutationFence;
    if (
      fingerprintMutationFence(fence) !==
      immutableRequest.mutationFenceFingerprint
    )
      throw new Error("gateway_mutation_fingerprint_mismatch");
    if (this.faults.beforeFinalValidationWait !== undefined)
      await this.faults.beforeFinalValidationWait(immutableRequest);
    return this.registry.queueMutation(immutableRequest, async () => {
      const prepared = this.registry.prepareMutation(immutableRequest);
      if (prepared.kind === "receipt") return prepared.receipt;
      if (immutableRequest.payload.kind === "submit") {
        try {
          await this.#lookup.assertSubmitCapacity(
            this.submitOperationIdentity(prepared.authorization),
          );
        } catch (error) {
          if (error instanceof GatewayPreMutationRefusal)
            return this.registry.completeMutation(prepared.authorization, {
              outcome: "rejected",
              reason: error.code,
            });
          const reason = this.lookupFailureReason(error);
          if (reason === "hyperqueue_retained_history_ceiling_reached")
            return this.registry.completeMutation(prepared.authorization, {
              outcome: "rejected",
              reason,
            });
          return this.registry.completeRejectedAndCordon(
            prepared.authorization,
            reason,
          );
        }
      }
      let result: HyperQueueCliMutationResult;
      try {
        result = await this.#cli.mutate(prepared.authorization);
        this.faults.afterCliCall?.();
      } catch (error) {
        if (error instanceof SimulatedGatewayCrash) throw error;
        if (error instanceof GatewayPreMutationRefusal)
          return this.registry.completeMutation(prepared.authorization, {
            outcome: "rejected",
            reason: error.code,
          });
        if (immutableRequest.payload.kind === "submit")
          return this.reconcileAmbiguousSubmit(prepared.authorization);
        return this.registry.completeMutation(prepared.authorization, {
          outcome: "unknown",
          reason: "hyperqueue_cli_outcome_ambiguous",
        });
      }
      if (immutableRequest.payload.kind === "submit") {
        try {
          this.persistSubmitMapping(prepared.authorization, {
            canonicalJobName: prepared.authorization.canonicalJobName,
            jobId: result.jobId,
            taskId: "0",
          });
        } catch (error) {
          if (error instanceof SimulatedGatewayCrash) throw error;
          if (error instanceof GatewayContractError)
            return this.registry.completeUnknownAndCordon(
              prepared.authorization,
              "ambiguous_submit_mapping_conflict",
            );
          throw error;
        }
      }
      return this.registry.completeMutation(prepared.authorization, {
        externalMappingOrInvocationId: result.externalReference,
        outcome: "applied",
        reason: "hyperqueue_cli_applied",
      });
    });
  }

  public async reconcileUnresolved(
    authorization: AuthorizedHyperQueueMutation,
  ) {
    return this.registry.queueMutation(authorization.request, async () => {
      const mapping = this.registry.dispatchMapping(
        authorization.request.operationId,
      );
      if (mapping !== undefined)
        return this.registry.completeMutation(authorization, {
          externalMappingOrInvocationId: mapping.adapterReference,
          outcome: "applied",
          reason: "gateway_recovered_durable_dispatch_mapping",
        });
      if (authorization.request.payload.kind === "submit")
        return await this.reconcileAmbiguousSubmit(authorization);
      return this.registry.completeUnknownAndCordon(
        authorization,
        "gateway_recovered_unresolved_cli_intent",
      );
    });
  }

  private async reconcileAmbiguousSubmit(
    authorization: AuthorizedHyperQueueMutation,
  ) {
    const jobName = authorization.canonicalJobName;
    if (jobName === undefined)
      return this.registry.completeUnknownAndCordon(
        authorization,
        "ambiguous_submit_job_name_missing",
      );
    try {
      validateCanonicalHyperQueueOperationJobName(
        this.submitOperationIdentity(authorization),
        jobName,
      );
      const lookup = await this.#lookup.lookup(
        this.submitOperationIdentity(authorization),
      );
      if (lookup.disposition === "zero")
        return this.registry.completeUnknownAndCordon(
          authorization,
          "ambiguous_submit_lookup_zero_matches",
        );
      if (lookup.disposition === "multiple")
        return this.registry.completeUnknownAndCordon(
          authorization,
          "ambiguous_submit_lookup_multiple_matches",
        );
      const match = lookup.matches[0];
      if (match?.jobName !== jobName)
        return this.registry.completeUnknownAndCordon(
          authorization,
          "ambiguous_submit_lookup_incomplete",
        );
      this.persistSubmitMapping(authorization, {
        canonicalJobName: match.jobName,
        jobId: match.jobId,
        taskId: match.taskId,
      });
      return this.registry.completeMutation(authorization, {
        externalMappingOrInvocationId: `hq://${match.jobId}`,
        outcome: "applied",
        reason: "hyperqueue_operation_name_correlated",
      });
    } catch (error) {
      if (error instanceof SimulatedGatewayCrash) throw error;
      if (error instanceof GatewayContractError)
        return this.registry.completeUnknownAndCordon(
          authorization,
          "ambiguous_submit_mapping_conflict",
        );
      return this.registry.completeUnknownAndCordon(
        authorization,
        this.lookupFailureReason(error),
      );
    }
  }

  private persistSubmitMapping(
    authorization: AuthorizedHyperQueueMutation,
    result: Readonly<{
      canonicalJobName: string | undefined;
      jobId: string;
      taskId: "0";
    }>,
  ): void {
    if (result.canonicalJobName === undefined)
      throw new GatewayContractError(
        "operation_conflict",
        "canonical_job_name_missing",
      );
    this.registry.persistDispatchMapping(authorization, {
      canonicalJobName: result.canonicalJobName,
      jobId: result.jobId,
      taskId: result.taskId,
    });
    this.faults.afterMappingPersist?.();
  }

  private lookupFailureReason(error: unknown): string {
    const message = error instanceof Error ? error.message : "";
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (
      message === "hyperqueue_operation_lookup_output_limit_exceeded" ||
      code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    )
      return "ambiguous_submit_lookup_oversized";
    if (message === "hyperqueue_operation_lookup_incomplete")
      return "ambiguous_submit_lookup_incomplete";
    if (message === "hyperqueue_operation_lookup_malformed")
      return "ambiguous_submit_lookup_malformed";
    if (message === "hyperqueue_retained_history_ceiling_reached")
      return "hyperqueue_retained_history_ceiling_reached";
    if (message === "hyperqueue_retained_history_ceiling_exceeded")
      return "hyperqueue_retained_history_ceiling_exceeded";
    if (message === "hyperqueue_operation_job_name_collision")
      return "hyperqueue_operation_job_name_collision";
    return "ambiguous_submit_lookup_invalid";
  }

  private submitOperationIdentity(authorization: AuthorizedHyperQueueMutation) {
    const payload = authorization.request.payload;
    if (payload.kind !== "submit")
      throw new GatewayContractError("operation_conflict", "submit_identity");
    return Object.freeze({
      mappingFingerprint: payload.mappingFingerprint,
      mutationFenceFingerprint: authorization.request.mutationFenceFingerprint,
      operationId: authorization.request.operationId,
      requestFingerprint: authorization.requestFingerprint,
      schedulerInstanceId: authorization.request.scope.schedulerInstanceId,
    });
  }
}

export function createProvider(
  registry: GatewayAuthorityRegistry,
  credential: GatewayCredentialConfig,
  release: GatewayCliReleaseConfig,
  faults?: GatewayMutationFaults,
): HyperQueueMutationBoundary {
  return new HyperQueueMutationBoundary(registry, credential, release, faults);
}

export type GatewayProvider = HyperQueueMutationBoundary;
