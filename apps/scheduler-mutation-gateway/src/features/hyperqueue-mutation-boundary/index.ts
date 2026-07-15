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
} from "@workload-funnel/scheduler-hyperqueue/hyperqueue-cli-mutation";
import {
  snapshotMutationRequest,
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
  readonly limits: HyperQueueCliLimits;
  readonly shimExecutable: string;
}

export interface GatewayMutationFaults {
  afterCliCall?(): void;
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
      result.stdout.trim() !== expectedVersionOutput ||
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

  public constructor(
    private readonly registry: GatewayAuthorityRegistry,
    credential: GatewayCredentialConfig,
    release: GatewayCliReleaseConfig,
    private readonly faults: GatewayMutationFaults = {},
  ) {
    this.#cli = new ExactVersionHyperQueueCliMutation({
      exactVersion: release.exactVersion,
      executor: new GatewayCredentialedExecutor(credential),
      expectedBinarySha256: release.expectedBinarySha256,
      limits: release.limits,
      shimExecutable: release.shimExecutable,
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
      try {
        const result = await this.#cli.mutate(prepared.authorization);
        this.faults.afterCliCall?.();
        return this.registry.completeMutation(prepared.authorization, {
          externalMappingOrInvocationId: result.externalReference,
          outcome: "applied",
          reason: "hyperqueue_cli_applied",
        });
      } catch (error) {
        if (error instanceof SimulatedGatewayCrash) throw error;
        if (error instanceof GatewayPreMutationRefusal)
          return this.registry.completeMutation(prepared.authorization, {
            outcome: "rejected",
            reason: error.code,
          });
        return this.registry.completeMutation(prepared.authorization, {
          outcome: "unknown",
          reason: "hyperqueue_cli_outcome_ambiguous",
        });
      }
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
