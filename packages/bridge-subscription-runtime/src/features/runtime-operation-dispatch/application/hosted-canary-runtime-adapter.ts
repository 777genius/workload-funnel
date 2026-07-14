import { isAbsolute, join, relative, resolve } from "node:path";

import { sha256Hex, type MutationFence } from "@workload-funnel/kernel";
import type { TargetOperationReceipt } from "@workload-funnel/node-execution/process-lifecycle";

import type {
  HostedCanaryAuthorityStore,
  HostedCanaryCapabilityEvidence,
  HostedCanaryExecutableIdentity,
  HostedCanaryForegroundHandle,
  HostedCanaryForegroundResult,
  HostedCanaryInvocationProfileResolver,
  HostedCanaryProcessRequest,
  HostedCanaryProcessResult,
  HostedCanaryProcessRunner,
  HostedCanaryRuntimeRelease,
  HostedCanarySandbox,
  HostedCanaryStartRequest,
  HostedCanaryStartResult,
  HostedCanaryStopRequest,
  HostedCanaryStopResult,
} from "./contracts/hosted-canary-runtime.js";
import {
  HOSTED_CANARY_DISPOSABLE_PURPOSE,
  HOSTED_CANARY_RUNTIME_CONTRACT,
} from "./contracts/hosted-canary-runtime.js";
import type {
  DurableRuntimeOperation,
  RuntimeOperationStore,
} from "./contracts/runtime-operation-store.js";
import {
  assertDeployedCliHelp,
  assertDeployedToolsCatalog,
  assertHostedCanaryFence,
  assertHostedCanaryFenceTime,
  assertSuccessfulProbe,
  buildForegroundArgv,
  operationFingerprint,
  unknownReceipt,
  validateInvocationProfile,
  validateStartRequest,
} from "./hosted-canary-runtime-policy.js";

export interface HostedCanaryRuntimeAdapterDependencies {
  readonly authorityStore: HostedCanaryAuthorityStore;
  readonly controllerId: string;
  readonly nowMs: () => number;
  readonly operationStore: RuntimeOperationStore;
  readonly profileResolver: HostedCanaryInvocationProfileResolver;
  readonly release: HostedCanaryRuntimeRelease;
  readonly runner: HostedCanaryProcessRunner;
  readonly sandbox: HostedCanarySandbox;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const environmentKeys = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "TMPDIR",
  "WORKLOAD_FUNNEL_CANARY_JOB_ROOT",
  "WORKLOAD_FUNNEL_CANARY_REGISTRY_ROOT",
  "WORKLOAD_FUNNEL_CANARY_STATE_ROOT",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function isWithin(root: string, path: string): boolean {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === "" || (!suffix.startsWith("..") && !isAbsolute(suffix));
}

function validateDependencies(input: HostedCanaryRuntimeAdapterDependencies) {
  const { release, sandbox } = input;
  const releaseWire = release as unknown as Readonly<Record<string, unknown>>;
  const sandboxWire = sandbox as unknown as Readonly<Record<string, unknown>>;
  const environment = Object.entries(sandbox.environment);
  const privateRoot = join(sandbox.projectRoot, ".workload-funnel-canary");
  const expectedRoots = Object.freeze({
    jobRoot: join(privateRoot, "jobs"),
    registryRoot: join(privateRoot, "registry"),
    stateRoot: join(privateRoot, "state"),
    temporaryRoot: join(privateRoot, "tmp"),
  });
  const expectedEnvironment = Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(expectedRoots.stateRoot, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: expectedRoots.temporaryRoot,
    WORKLOAD_FUNNEL_CANARY_JOB_ROOT: expectedRoots.jobRoot,
    WORKLOAD_FUNNEL_CANARY_REGISTRY_ROOT: expectedRoots.registryRoot,
    WORKLOAD_FUNNEL_CANARY_STATE_ROOT: expectedRoots.stateRoot,
    XDG_CACHE_HOME: join(expectedRoots.stateRoot, "cache"),
    XDG_CONFIG_HOME: join(expectedRoots.stateRoot, "config"),
    XDG_DATA_HOME: join(expectedRoots.stateRoot, "data"),
    XDG_STATE_HOME: expectedRoots.stateRoot,
  });
  if (
    releaseWire["contractVersion"] !== HOSTED_CANARY_RUNTIME_CONTRACT ||
    releaseWire["productionStartsEnabled"] !== false ||
    !isAbsolute(release.executable) ||
    !/^[a-f0-9]{64}$/u.test(release.expectedBinarySha256) ||
    !/^[a-f0-9]{64}$/u.test(release.expectedCliHelpSha256) ||
    !/^[a-f0-9]{64}$/u.test(release.expectedToolsCatalogSha256) ||
    !identifierPattern.test(input.controllerId) ||
    typeof input.nowMs !== "function" ||
    typeof input.profileResolver.resolve !== "function" ||
    sandboxWire["canaryPurpose"] !== HOSTED_CANARY_DISPOSABLE_PURPOSE ||
    !/^[a-f0-9]{64}$/u.test(sandbox.projectFingerprint) ||
    !isAbsolute(sandbox.projectRoot) ||
    !sandbox.projectRoot
      .split("/")
      .at(-1)
      ?.startsWith("workload-funnel-disposable-canary-") ||
    ![
      sandbox.jobRoot,
      sandbox.registryRoot,
      sandbox.stateRoot,
      sandbox.temporaryRoot,
    ].every(
      (path) => isAbsolute(path) && isWithin(sandbox.projectRoot, path),
    ) ||
    sandbox.jobRoot !== expectedRoots.jobRoot ||
    sandbox.registryRoot !== expectedRoots.registryRoot ||
    sandbox.stateRoot !== expectedRoots.stateRoot ||
    sandbox.temporaryRoot !== expectedRoots.temporaryRoot ||
    !Number.isSafeInteger(release.limits.maxOutputBytes) ||
    release.limits.maxOutputBytes < 1_024 ||
    release.limits.maxOutputBytes > 2 * 1024 * 1024 ||
    !Number.isSafeInteger(release.limits.probeTimeoutMs) ||
    release.limits.probeTimeoutMs < 1 ||
    release.limits.probeTimeoutMs > 60_000 ||
    !Number.isSafeInteger(release.limits.foregroundTimeoutMs) ||
    release.limits.foregroundTimeoutMs < 1 ||
    release.limits.foregroundTimeoutMs > 15 * 60_000 ||
    environment.length !== environmentKeys.size ||
    environment.some(
      ([key, value]) =>
        !environmentKeys.has(key) ||
        typeof value !== "string" ||
        value.length > 4_096 ||
        value.includes("\u0000") ||
        expectedEnvironment[key as keyof typeof expectedEnvironment] !== value,
    )
  )
    throw new Error("hosted_canary_adapter_configuration_invalid");
}

function exactOperation(
  left: DurableRuntimeOperation,
  right: DurableRuntimeOperation,
): boolean {
  return (
    left.boundary === right.boundary &&
    left.idempotencyKey === right.idempotencyKey &&
    left.intentFingerprint === right.intentFingerprint &&
    left.mutationFenceFingerprint === right.mutationFenceFingerprint &&
    left.operationId === right.operationId &&
    left.runtimeTargetId === right.runtimeTargetId
  );
}

export class HostedCanaryRuntimeAdapter {
  readonly #dependencies: HostedCanaryRuntimeAdapterDependencies;
  #capabilities: HostedCanaryCapabilityEvidence | undefined;
  #executableIdentity: HostedCanaryExecutableIdentity | undefined;
  #foreground: HostedCanaryForegroundHandle | undefined;
  #foregroundTaskId: string | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  public constructor(dependencies: HostedCanaryRuntimeAdapterDependencies) {
    validateDependencies(dependencies);
    this.#dependencies = dependencies;
  }

  public async discoverCapabilities(): Promise<HostedCanaryCapabilityEvidence> {
    if (this.#capabilities !== undefined) return this.#capabilities;
    const identity = await this.#dependencies.runner.inspectExecutable(
      this.#dependencies.release.executable,
    );
    this.assertExpectedExecutable(identity);
    this.#executableIdentity = identity;
    const cliHelp = await this.runRead(["--help"]);
    const toolsCatalog = await this.runRead(["tools"]);
    assertDeployedCliHelp(cliHelp.stdout);
    assertDeployedToolsCatalog(toolsCatalog.stdout);
    const cliHelpSha256 = sha256Hex(cliHelp.stdout);
    const toolsCatalogSha256 = sha256Hex(toolsCatalog.stdout);
    if (
      cliHelpSha256 !== this.#dependencies.release.expectedCliHelpSha256 ||
      toolsCatalogSha256 !==
        this.#dependencies.release.expectedToolsCatalogSha256
    )
      throw new Error("hosted_canary_exact_contract_mismatch");
    this.#capabilities = Object.freeze({
      binarySha256: identity.sha256,
      cliHelpSha256,
      contractVersion: HOSTED_CANARY_RUNTIME_CONTRACT,
      foregroundNoTmux: true,
      startToolInvocation: "forbidden_tmux_path",
      toolJsonUsesCamelCase: true,
      toolsCatalogSha256,
    });
    return this.#capabilities;
  }

  public installAuthority(
    fence: Parameters<HostedCanaryAuthorityStore["install"]>[0],
    fingerprint: string,
  ): Promise<"idempotent" | "installed"> {
    return this.serializeMutation(() =>
      Promise.resolve(
        this.#dependencies.authorityStore.install(fence, fingerprint),
      ),
    );
  }

  public async start(
    request: HostedCanaryStartRequest,
  ): Promise<HostedCanaryStartResult> {
    const fence = request.ticket.mutationFence;
    const fingerprint = request.ticket.mutationFenceFingerprint;
    assertHostedCanaryFence(fence, fingerprint, "process_start");
    assertHostedCanaryFenceTime(fence, this.#dependencies.nowMs());
    this.#dependencies.authorityStore.assertCurrent(fence, fingerprint);
    validateStartRequest(request, this.#dependencies.sandbox);
    this.requiredCapabilities();
    const profile = await this.resolveProfile(request.invocationProfileId);
    const operation = this.operation(
      request.ticket.operationId,
      "foreground",
      request.ticket.runtimeTargetId,
      fingerprint,
      [request.invocationProfileId, profile.profileRevision, request.taskId],
    );
    const argv = buildForegroundArgv(
      request,
      profile,
      this.#dependencies.sandbox,
    );
    const foregroundStart = await this.mutationPhase(
      operation,
      fence,
      async () => {
        const handle = await this.#dependencies.runner.startForeground(
          this.processRequest(
            argv,
            this.#dependencies.release.limits.foregroundTimeoutMs,
          ),
        );
        this.#foreground = handle;
        this.#foregroundTaskId = request.taskId;
        return Object.freeze({
          mutationFenceFingerprint: fingerprint,
          operationId: operation.operationId,
          runtimeBuildSha: this.requiredCapabilities().binarySha256,
          runtimeOperationId: request.taskId,
          state: "accepted" as const,
        });
      },
      true,
    );
    return Object.freeze({
      foregroundStart,
      state: foregroundStart.state === "unknown" ? "unknown" : "accepted",
    });
  }

  public async stop(
    request: HostedCanaryStopRequest,
  ): Promise<HostedCanaryStopResult> {
    assertHostedCanaryFence(
      request.mutationFence,
      request.mutationFenceFingerprint,
      "process_stop",
    );
    assertHostedCanaryFenceTime(
      request.mutationFence,
      this.#dependencies.nowMs(),
    );
    this.#dependencies.authorityStore.assertCurrent(
      request.mutationFence,
      request.mutationFenceFingerprint,
    );
    this.requiredCapabilities();
    const operation = this.operation(
      request.operationId,
      "foreground-stop",
      request.runtimeTargetId,
      request.mutationFenceFingerprint,
      ["outer-process-termination"],
    );
    let foregroundCompletion: HostedCanaryForegroundResult | undefined;
    const receipt = await this.mutationPhase(
      operation,
      request.mutationFence,
      async () => {
        const foreground = this.#foreground;
        if (foreground === undefined)
          throw new Error("hosted_canary_foreground_not_owned");
        foreground.terminate();
        foregroundCompletion = await foreground.completion;
        return Object.freeze({
          mutationFenceFingerprint: request.mutationFenceFingerprint,
          operationId: operation.operationId,
          runtimeBuildSha: this.requiredCapabilities().binarySha256,
          ...(this.#foregroundTaskId === undefined
            ? {}
            : { runtimeOperationId: this.#foregroundTaskId }),
          state: "completed" as const,
        });
      },
    );
    return Object.freeze({
      ...(foregroundCompletion === undefined ? {} : { foregroundCompletion }),
      receipt,
    });
  }

  public foregroundCompletion():
    | Promise<HostedCanaryForegroundResult>
    | undefined {
    return this.#foreground?.completion;
  }

  public terminateForeground(): void {
    this.#foreground?.terminate();
  }

  private async resolveProfile(profileId: string) {
    let profile;
    try {
      profile = await this.#dependencies.profileResolver.resolve(profileId);
    } catch {
      throw new Error("hosted_canary_trusted_profile_unavailable");
    }
    validateInvocationProfile(
      profile,
      profileId,
      this.#dependencies.sandbox.projectRoot,
    );
    return profile;
  }

  private async mutationPhase(
    operation: DurableRuntimeOperation,
    fence: MutationFence,
    effect: () => Promise<TargetOperationReceipt>,
    verifyRuntimeRelease = false,
  ): Promise<TargetOperationReceipt> {
    return this.serializeMutation(async () => {
      const prior = await this.#dependencies.operationStore.find(
        operation.idempotencyKey,
      );
      if (prior !== undefined && !exactOperation(prior, operation))
        throw new Error("hosted_canary_operation_identity_conflict");
      if (prior?.receipt !== undefined) return prior.receipt;
      if (prior !== undefined)
        return unknownReceipt(
          operation.operationId,
          operation.mutationFenceFingerprint,
        );
      const reserved =
        await this.#dependencies.operationStore.reserve(operation);
      if (!exactOperation(reserved, operation))
        throw new Error("hosted_canary_operation_identity_conflict");
      if (verifyRuntimeRelease) {
        await this.assertExecutableUnchanged();
        await this.assertContractUnchanged();
      }
      assertHostedCanaryFenceTime(fence, this.#dependencies.nowMs());
      this.#dependencies.authorityStore.assertCurrent(
        fence,
        operation.mutationFenceFingerprint,
      );
      try {
        const receipt = await effect();
        await this.#dependencies.operationStore.save(operation, receipt);
        return receipt;
      } catch {
        await this.#dependencies.operationStore.saveUnknown(operation);
        return unknownReceipt(
          operation.operationId,
          operation.mutationFenceFingerprint,
        );
      }
    });
  }

  private operation(
    baseOperationId: string,
    phase: string,
    runtimeTargetId: string,
    mutationFenceFingerprint: string,
    payload: readonly string[],
  ): DurableRuntimeOperation {
    if (
      !identifierPattern.test(baseOperationId) ||
      !identifierPattern.test(runtimeTargetId)
    )
      throw new Error("hosted_canary_operation_identity_invalid");
    const operationId = `${baseOperationId.slice(0, 170)}:${phase}:${sha256Hex(baseOperationId).slice(0, 16)}`;
    return Object.freeze({
      boundary: "runtime",
      idempotencyKey: operationId,
      intentFingerprint: operationFingerprint([operationId, ...payload]),
      mutationFenceFingerprint,
      operationId,
      runtimeTargetId,
      state: "pending",
    });
  }

  private async runRead(
    argv: readonly string[],
  ): Promise<HostedCanaryProcessResult> {
    const result = await this.#dependencies.runner.run(
      this.processRequest(
        argv,
        this.#dependencies.release.limits.probeTimeoutMs,
      ),
    );
    assertSuccessfulProbe(result);
    return result;
  }

  private processRequest(
    argv: readonly string[],
    timeoutMs: number,
  ): HostedCanaryProcessRequest {
    return Object.freeze({
      argv: Object.freeze([...argv]),
      cwd: this.#dependencies.sandbox.projectRoot,
      environment: this.#dependencies.sandbox.environment,
      executable: this.#dependencies.release.executable,
      expectedExecutableIdentity:
        this.#executableIdentity ??
        (() => {
          throw new Error("hosted_canary_executable_identity_required");
        })(),
      maxOutputBytes: this.#dependencies.release.limits.maxOutputBytes,
      timeoutMs,
    });
  }

  private assertExpectedExecutable(
    identity: HostedCanaryExecutableIdentity,
  ): void {
    if (identity.sha256 !== this.#dependencies.release.expectedBinarySha256)
      throw new Error("hosted_canary_runtime_build_mismatch");
  }

  private async assertExecutableUnchanged(): Promise<void> {
    const expected = this.#executableIdentity;
    if (expected === undefined)
      throw new Error("hosted_canary_capability_discovery_required");
    const actual = await this.#dependencies.runner.inspectExecutable(
      this.#dependencies.release.executable,
    );
    this.assertExpectedExecutable(actual);
    if (
      actual.device !== expected.device ||
      actual.inode !== expected.inode ||
      actual.modifiedMs !== expected.modifiedMs ||
      actual.size !== expected.size
    )
      throw new Error("hosted_canary_runtime_executable_changed");
  }

  private async assertContractUnchanged(): Promise<void> {
    const expected = this.requiredCapabilities();
    const cliHelp = await this.runRead(["--help"]);
    const toolsCatalog = await this.runRead(["tools"]);
    assertDeployedCliHelp(cliHelp.stdout);
    assertDeployedToolsCatalog(toolsCatalog.stdout);
    if (
      sha256Hex(cliHelp.stdout) !== expected.cliHelpSha256 ||
      sha256Hex(toolsCatalog.stdout) !== expected.toolsCatalogSha256
    )
      throw new Error("hosted_canary_runtime_contract_changed");
  }

  private requiredCapabilities(): HostedCanaryCapabilityEvidence {
    if (this.#capabilities === undefined)
      throw new Error("hosted_canary_capability_discovery_required");
    return this.#capabilities;
  }

  private serializeMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(task, task);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
