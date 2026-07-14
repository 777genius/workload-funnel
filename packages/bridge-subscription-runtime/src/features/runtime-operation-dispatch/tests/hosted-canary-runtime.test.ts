import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { prepareRuntimeExecutionTicket } from "@workload-funnel/bridge-subscription-runtime/execution-ticket-preparation";
import { fingerprintMutationFence, sha256Hex } from "@workload-funnel/kernel";

import type {
  HostedCanaryInvocationProfile,
  HostedCanaryProcessRequest,
  HostedCanaryProcessResult,
  HostedCanaryProcessRunner,
  HostedCanaryRuntimeRelease,
} from "../application/contracts/hosted-canary-runtime.js";
import {
  HOSTED_CANARY_DISPOSABLE_PURPOSE,
  HOSTED_CANARY_RUNTIME_CONTRACT,
} from "../application/contracts/hosted-canary-runtime.js";
import { HostedCanaryRuntimeAdapter } from "../application/hosted-canary-runtime-adapter.js";
import { FilesystemHostedCanaryAuthorityStore } from "../filesystem-hosted-canary-authority-store.js";
import { FilesystemRuntimeOperationStore } from "../filesystem-runtime-operation-store.js";

const deployedCliHelpFixture = `usage:
  subscription-runtime-codex-goal run --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b [--tmux-session <name>] [--registry-root <dir>]
  subscription-runtime-codex-goal tools
defaults:
  --model gpt-5.5 --effort high --service-tier default --execution-engine app-server-goal --timeout 72h --app-server-startup-timeout-ms 120000 --max-account-cycles 5
escape hatches:
  --dry-run, --print-command, --no-tmux, --no-require-git-workspace
`;

function deployedToolsCatalogFixture(useSnakeCase = false): string {
  const properties: Record<string, unknown> = Object.fromEntries(
    [
      "jobId",
      "jobRootDir",
      "authRootDir",
      "stateRootDir",
      "workspacePath",
      "promptPath",
      "taskId",
      "outputPath",
      "progressPath",
      "model",
      "reasoningEffort",
      "serviceTier",
      "executionEngine",
      "accessBoundary",
      "networkAccess",
      "outputFormat",
      "registryRootDir",
    ].map((field) => [field, { type: "string" }]),
  );
  properties["accounts"] = {
    anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }],
  };
  properties["projectAccessScope"] = {
    additionalProperties: {},
    propertyNames: { type: "string" },
    type: "object",
  };
  if (useSnakeCase) {
    delete properties["jobId"];
    properties["job_id"] = { type: "string" };
  }
  return JSON.stringify({
    tools: [
      {
        description:
          "Start a detached tmux Codex goal worker after explicit confirmation.",
        inputSchema: { properties, type: "object" },
        name: "codex_goal_start",
      },
    ],
  });
}

const binarySha = sha256Hex("fake-hosted-canary-runtime-v1");
const nowMs = 10_000_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

class FakeRunner implements HostedCanaryProcessRunner {
  public binarySha = binarySha;
  public cliHelp = deployedCliHelpFixture;
  public failForeground = false;
  public readonly processCalls: {
    readonly kind: "foreground" | "run";
    readonly request: HostedCanaryProcessRequest;
  }[] = [];
  public terminateCalls = 0;
  public toolsCatalog = deployedToolsCatalogFixture();

  public inspectExecutable() {
    return Promise.resolve({
      device: 1,
      inode: 2,
      modifiedMs: 3,
      sha256: this.binarySha,
      size: 4,
    });
  }

  public run(
    request: HostedCanaryProcessRequest,
  ): Promise<HostedCanaryProcessResult> {
    this.processCalls.push({ kind: "run", request });
    if (request.argv.length === 1 && request.argv[0] === "--help")
      return this.result(this.cliHelp);
    if (request.argv.length === 1 && request.argv[0] === "tools")
      return this.result(this.toolsCatalog);
    return this.result("", 2);
  }

  public startForeground(request: HostedCanaryProcessRequest) {
    this.processCalls.push({ kind: "foreground", request });
    if (this.failForeground)
      return Promise.reject(new Error("fake_spawn_outcome_unknown"));
    return Promise.resolve(
      Object.freeze({
        completion: Promise.resolve(
          Object.freeze({ exitCode: null, timedOut: false }),
        ),
        terminate: () => {
          this.terminateCalls += 1;
        },
      }),
    );
  }

  public clear(): void {
    this.processCalls.splice(0);
  }

  private result(
    stdout: string,
    exitCode = 0,
  ): Promise<HostedCanaryProcessResult> {
    return Promise.resolve(
      Object.freeze({ exitCode, stderr: "", stdout, timedOut: false }),
    );
  }
}

function startFence(overrides = {}) {
  return Object.freeze({
    allocationId: "allocation-canary",
    attemptId: "attempt-canary",
    clusterIncarnation: "cluster-canary",
    clusterIncarnationVersion: 7,
    desiredEffect: "process_start" as const,
    effectScopeKey: "runtime-canary:attempt-canary",
    executionGeneration: "generation-canary",
    expectedDesiredVersion: 4,
    issuedStartRevocationRevision: 3,
    namespaceId: "test://hosted-canary",
    namespaceWriterEpoch: 8,
    nodeBootEpoch: 9,
    nodeId: "node-canary",
    notAfter: nowMs + 60_000,
    notBefore: nowMs - 1_000,
    operationGateRevision: 6,
    ownerFence: 5,
    requiredGate: "process_start",
    schemaVersion: 1 as const,
    startFence: "start-canary",
    supersessionKey: "runtime-canary-start",
    ...overrides,
  });
}

function stopFence(start: ReturnType<typeof startFence>) {
  const {
    issuedStartRevocationRevision: _issuedStartRevocationRevision,
    startFence: _startFence,
    ...shared
  } = start;
  void _issuedStartRevocationRevision;
  void _startFence;
  return Object.freeze({
    ...shared,
    desiredEffect: "process_stop" as const,
    expectedDesiredVersion: start.expectedDesiredVersion + 1,
    operationGateRevision: start.operationGateRevision + 1,
    requiredGate: "process_stop",
    supersessionKey: "runtime-canary-stop",
  });
}

function environment(root: string): Readonly<Record<string, string>> {
  const privateRoot = join(root, ".workload-funnel-canary");
  const stateRoot = join(privateRoot, "state");
  return Object.freeze({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(stateRoot, "home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PATH: "/usr/local/bin:/usr/bin:/bin",
    TMPDIR: join(privateRoot, "tmp"),
    WORKLOAD_FUNNEL_CANARY_JOB_ROOT: join(privateRoot, "jobs"),
    WORKLOAD_FUNNEL_CANARY_REGISTRY_ROOT: join(privateRoot, "registry"),
    WORKLOAD_FUNNEL_CANARY_STATE_ROOT: stateRoot,
    XDG_CACHE_HOME: join(stateRoot, "cache"),
    XDG_CONFIG_HOME: join(stateRoot, "config"),
    XDG_DATA_HOME: join(stateRoot, "data"),
    XDG_STATE_HOME: stateRoot,
  });
}

function release(root: string): HostedCanaryRuntimeRelease {
  return Object.freeze({
    contractVersion: HOSTED_CANARY_RUNTIME_CONTRACT,
    executable: join(root, "subscription-runtime-codex-goal"),
    expectedBinarySha256: binarySha,
    expectedCliHelpSha256: sha256Hex(deployedCliHelpFixture),
    expectedToolsCatalogSha256: sha256Hex(deployedToolsCatalogFixture()),
    limits: Object.freeze({
      foregroundTimeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
      probeTimeoutMs: 1_000,
    }),
    productionStartsEnabled: false,
  });
}

function profile(root: string): HostedCanaryInvocationProfile {
  return Object.freeze({
    accessBoundary: "isolated_workspace_write",
    accountSelectors: Object.freeze(["canary-account-a"]),
    authRoot: resolve(root, "..", "operator-owned-runtime-auth"),
    executionEngine: "app-server-goal",
    model: "gpt-5.5",
    networkAccess: "restricted",
    profileId: "hosted-canary-profile",
    profileRevision: "revision-1",
    reasoningEffort: "high",
    serviceTier: "default",
  });
}

function fixture(
  root: string,
  runner: FakeRunner,
  options: {
    readonly missingProfile?: boolean;
    readonly runtimeEnvironment?: Readonly<Record<string, string>>;
  } = {},
) {
  const privateRoot = join(root, ".workload-funnel-canary");
  const stateRoot = join(privateRoot, "state");
  const authorityStore = new FilesystemHostedCanaryAuthorityStore({
    directory: join(stateRoot, "authority"),
  });
  const adapter = new HostedCanaryRuntimeAdapter({
    authorityStore,
    controllerId: "hosted-canary-test",
    nowMs: () => nowMs,
    operationStore: new FilesystemRuntimeOperationStore({
      capacity: 64,
      directory: join(stateRoot, "operations"),
    }),
    profileResolver: {
      resolve: () =>
        options.missingProfile
          ? Promise.reject(new Error("PRIVATE_PROFILE_DETAILS"))
          : Promise.resolve(profile(root)),
    },
    release: release(root),
    runner,
    sandbox: {
      canaryPurpose: HOSTED_CANARY_DISPOSABLE_PURPOSE,
      environment: options.runtimeEnvironment ?? environment(root),
      jobRoot: join(privateRoot, "jobs"),
      projectRoot: root,
      projectFingerprint: sha256Hex(root),
      registryRoot: join(privateRoot, "registry"),
      stateRoot,
      temporaryRoot: join(privateRoot, "tmp"),
    },
  });
  return { adapter, authorityStore };
}

function preparedTicket(fence: ReturnType<typeof startFence>) {
  return prepareRuntimeExecutionTicket({
    causationId: "canary-cause",
    correlationId: "canary-correlation",
    expiresAtMs: fence.notAfter,
    idempotencyKey: "canary-idempotency",
    issuedAtMs: fence.notBefore,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: "canary-operation",
    projectId: "disposable-canary",
    requestId: "canary-request",
    runtimeTargetId: "hosted-runtime-canary",
    sandboxProfileDigest: sha256Hex("canary-sandbox"),
    ticketId: "canary-ticket",
  });
}

function request(root: string, fence: ReturnType<typeof startFence>) {
  return Object.freeze({
    invocationProfileId: "hosted-canary-profile",
    promptPath: join(root, "hosted-canary-prompt.md"),
    taskId: "workload-funnel-hosted-canary-task",
    ticket: preparedTicket(fence),
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), "workload-funnel-disposable-canary-test-"),
  );
  roots.push(root);
  return root;
}

describe("hosted subscription-runtime foreground boundary", () => {
  test("probes the deployed root help and tools catalog with camelCase fields", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const adapter = fixture(root, runner).adapter;

    await expect(adapter.discoverCapabilities()).resolves.toMatchObject({
      foregroundNoTmux: true,
      startToolInvocation: "forbidden_tmux_path",
      toolJsonUsesCamelCase: true,
    });
    expect(runner.processCalls.map(({ request: call }) => call.argv)).toEqual([
      ["--help"],
      ["tools"],
    ]);

    const snakeRoot = await temporaryRoot();
    const snakeRunner = new FakeRunner();
    snakeRunner.toolsCatalog = deployedToolsCatalogFixture(true);
    await expect(
      fixture(snakeRoot, snakeRunner).adapter.discoverCapabilities(),
    ).rejects.toThrow("hosted_canary_required_tool_contract_missing");

    const changedRoot = await temporaryRoot();
    const changedRunner = new FakeRunner();
    changedRunner.cliHelp = `${deployedCliHelpFixture}changed-release\n`;
    await expect(
      fixture(changedRoot, changedRunner).adapter.discoverCapabilities(),
    ).rejects.toThrow("hosted_canary_exact_contract_mismatch");
  });

  test("launches one complete argv-only foreground child and never invokes a tool", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const { adapter, authorityStore } = fixture(root, runner);
    const fence = startFence();
    authorityStore.install(fence, fingerprintMutationFence(fence));
    await adapter.discoverCapabilities();
    runner.clear();

    const started = await adapter.start(request(root, fence));
    expect(started.state).toBe("accepted");
    expect(runner.processCalls.map(({ request: call }) => call.argv)).toEqual([
      ["--help"],
      ["tools"],
      expect.any(Array),
    ]);
    const call = runner.processCalls.find(({ kind }) => kind === "foreground");
    expect(call?.kind).toBe("foreground");
    const argv = call?.request.argv ?? [];
    const privateRoot = join(root, ".workload-funnel-canary");
    const stateRoot = join(privateRoot, "state");
    const registryRoot = join(privateRoot, "registry");
    expect(argv).toEqual([
      "run",
      "--no-tmux",
      "--job-root",
      join(privateRoot, "jobs"),
      "--auth-root",
      resolve(root, "..", "operator-owned-runtime-auth"),
      "--workspace",
      root,
      "--prompt",
      join(root, "hosted-canary-prompt.md"),
      "--task-id",
      "workload-funnel-hosted-canary-task",
      "--accounts",
      "canary-account-a",
      "--format",
      "json",
      "--state-root",
      stateRoot,
      "--job-id",
      "workload-funnel-hosted-canary-task",
      "--registry-root",
      registryRoot,
      "--output",
      join(stateRoot, "runtime-result.json"),
      "--progress",
      join(stateRoot, "runtime-progress.json"),
      "--model",
      "gpt-5.5",
      "--effort",
      "high",
      "--service-tier",
      "default",
      "--execution-engine",
      "app-server-goal",
      "--access-boundary",
      "isolated_workspace_write",
      "--project-access-scope-json",
      JSON.stringify({
        isolatedWorkspaceRoot: root,
        projectId: "disposable-canary",
        readRoots: [root],
        registryRoot,
        workspaceRoots: [root],
      }),
      "--network-access",
      "restricted",
    ]);
    expect(argv).not.toContain("tool");
    expect(argv).not.toContain("codex_goal_start");
    expect(argv).not.toContain("tmux");
    expect(
      runner.processCalls.some(({ request: processRequest }) =>
        processRequest.argv.includes("codex_goal_start"),
      ),
    ).toBe(false);
    expect(call?.request.environment).toEqual(environment(root));
    expect(Object.keys(call?.request.environment ?? {})).not.toContain(
      "SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT",
    );

    const stopping = stopFence(fence);
    authorityStore.install(stopping, fingerprintMutationFence(stopping));
    await expect(
      adapter.stop({
        mutationFence: stopping,
        mutationFenceFingerprint: fingerprintMutationFence(stopping),
        operationId: "canary-operation",
        runtimeTargetId: "hosted-runtime-canary",
      }),
    ).resolves.toMatchObject({ receipt: { state: "completed" } });
    expect(runner.terminateCalls).toBe(1);

    const wal = await readFile(
      join(
        root,
        ".workload-funnel-canary/state/operations/runtime-operations.wal",
      ),
      "utf8",
    );
    expect(wal).not.toContain("operator-owned-runtime-auth");
    expect(wal).not.toContain("canary-account-a");
  });

  test("fails closed without a trusted profile before any foreground effect", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const { adapter, authorityStore } = fixture(root, runner, {
      missingProfile: true,
    });
    const fence = startFence();
    authorityStore.install(fence, fingerprintMutationFence(fence));
    await adapter.discoverCapabilities();
    runner.clear();

    await expect(adapter.start(request(root, fence))).rejects.toThrow(
      "hosted_canary_trusted_profile_unavailable",
    );
    expect(runner.processCalls).toEqual([]);
  });

  test("rechecks the effective release at the final boundary and never replays drift", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const { adapter, authorityStore } = fixture(root, runner);
    const fence = startFence();
    authorityStore.install(fence, fingerprintMutationFence(fence));
    await adapter.discoverCapabilities();
    runner.clear();
    runner.cliHelp = `${deployedCliHelpFixture}release-drift\n`;

    await expect(adapter.start(request(root, fence))).rejects.toThrow(
      "hosted_canary_runtime_contract_changed",
    );
    expect(
      runner.processCalls.filter(({ kind }) => kind === "foreground"),
    ).toEqual([]);
    runner.clear();
    expect((await adapter.start(request(root, fence))).state).toBe("unknown");
    expect(runner.processCalls).toEqual([]);
  });

  test("replays accepted and ambiguous starts without repeating the effect", async () => {
    const acceptedRoot = await temporaryRoot();
    const acceptedFence = startFence();
    const firstRunner = new FakeRunner();
    const first = fixture(acceptedRoot, firstRunner);
    first.authorityStore.install(
      acceptedFence,
      fingerprintMutationFence(acceptedFence),
    );
    await first.adapter.discoverCapabilities();
    await first.adapter.start(request(acceptedRoot, acceptedFence));

    const replayRunner = new FakeRunner();
    const replay = fixture(acceptedRoot, replayRunner);
    await replay.adapter.discoverCapabilities();
    replayRunner.clear();
    expect(
      (await replay.adapter.start(request(acceptedRoot, acceptedFence))).state,
    ).toBe("accepted");
    expect(replayRunner.processCalls).toEqual([]);

    const ambiguousRoot = await temporaryRoot();
    const ambiguousFence = startFence();
    const failingRunner = new FakeRunner();
    failingRunner.failForeground = true;
    const failing = fixture(ambiguousRoot, failingRunner);
    failing.authorityStore.install(
      ambiguousFence,
      fingerprintMutationFence(ambiguousFence),
    );
    await failing.adapter.discoverCapabilities();
    failingRunner.clear();
    expect(
      (await failing.adapter.start(request(ambiguousRoot, ambiguousFence)))
        .state,
    ).toBe("unknown");
    expect(
      failingRunner.processCalls.filter(({ kind }) => kind === "foreground"),
    ).toHaveLength(1);

    const ambiguousReplayRunner = new FakeRunner();
    const ambiguousReplay = fixture(ambiguousRoot, ambiguousReplayRunner);
    await ambiguousReplay.adapter.discoverCapabilities();
    ambiguousReplayRunner.clear();
    expect(
      (
        await ambiguousReplay.adapter.start(
          request(ambiguousRoot, ambiguousFence),
        )
      ).state,
    ).toBe("unknown");
    expect(ambiguousReplayRunner.processCalls).toEqual([]);
  });

  test("coalesces concurrent exact starts to one foreground effect", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const { adapter, authorityStore } = fixture(root, runner);
    const fence = startFence();
    authorityStore.install(fence, fingerprintMutationFence(fence));
    await adapter.discoverCapabilities();
    runner.clear();

    const results = await Promise.all([
      adapter.start(request(root, fence)),
      adapter.start(request(root, fence)),
    ]);
    expect(results.map(({ state }) => state)).toEqual(["accepted", "accepted"]);
    expect(
      runner.processCalls.filter(({ kind }) => kind === "foreground"),
    ).toHaveLength(1);
  });

  test("rejects stale, equal-mismatched, expired, and escaped inputs without effects", async () => {
    const root = await temporaryRoot();
    const runner = new FakeRunner();
    const { adapter, authorityStore } = fixture(root, runner);
    const first = startFence();

    await expect(adapter.start(request(root, first))).rejects.toThrow(
      "hosted_canary_authority_not_current",
    );
    authorityStore.install(first, fingerprintMutationFence(first));
    await adapter.discoverCapabilities();
    const current = startFence({ expectedDesiredVersion: 5 });
    authorityStore.install(current, fingerprintMutationFence(current));
    runner.clear();
    await expect(adapter.start(request(root, first))).rejects.toThrow(
      "hosted_canary_authority_not_current",
    );
    expect(() =>
      authorityStore.install(first, fingerprintMutationFence(first)),
    ).toThrow("hosted_canary_authority_lower_desired");

    const equalMismatch = startFence({
      clusterIncarnation: "other-cluster",
      expectedDesiredVersion: 6,
    });
    expect(() =>
      authorityStore.install(
        equalMismatch,
        fingerprintMutationFence(equalMismatch),
      ),
    ).toThrow("hosted_canary_authority_equal_mismatch_cluster");

    const expired = startFence({ expectedDesiredVersion: 6, notAfter: nowMs });
    authorityStore.install(expired, fingerprintMutationFence(expired));
    await expect(adapter.start(request(root, expired))).rejects.toThrow(
      "hosted_canary_mutation_fence_expired",
    );

    const valid = startFence({ expectedDesiredVersion: 7 });
    authorityStore.install(valid, fingerprintMutationFence(valid));
    await expect(
      adapter.start({
        ...request(root, valid),
        promptPath: join(root, "..", "real-user-project", "prompt.md"),
      }),
    ).rejects.toThrow("hosted_canary_start_request_invalid");
    expect(runner.processCalls).toEqual([]);
  });

  test("requires exact executable and closed environment contracts", async () => {
    const root = await temporaryRoot();
    const wrongBuild = new FakeRunner();
    wrongBuild.binarySha = sha256Hex("wrong-build");
    await expect(
      fixture(root, wrongBuild).adapter.discoverCapabilities(),
    ).rejects.toThrow("hosted_canary_runtime_build_mismatch");
    expect(wrongBuild.processCalls).toEqual([]);

    const environmentRoot = await temporaryRoot();
    const escapedEnvironment = Object.freeze({
      ...environment(environmentRoot),
      AUTH_TOKEN: "must-not-be-inherited",
    });
    expect(() =>
      fixture(environmentRoot, new FakeRunner(), {
        runtimeEnvironment: escapedEnvironment,
      }),
    ).toThrow("hosted_canary_adapter_configuration_invalid");
  });
});
