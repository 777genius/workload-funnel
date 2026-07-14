import { Buffer } from "node:buffer";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  CANARY_EXPECTED_ARTIFACT_CONTENT,
  CANARY_EXPECTED_ARTIFACT_FILE,
  CANARY_GOAL_PROMPT,
  canaryEnvironment,
  DISPOSABLE_SENTINEL_FILE,
  DISPOSABLE_SENTINEL_PURPOSE,
  validateDisposableProject,
} from "./disposable-project.mjs";
import { createNodeHostedCanaryProcessRunner } from "./node-process-runner.mjs";
import {
  HOSTED_CANARY_CHANGED_FILES_MAX_ITEMS,
  HOSTED_CANARY_TERMINAL_RESULT_MAX_BYTES,
  runHostedCanaryCommand,
} from "./run.mjs";

const roots = [];
const brokeredStartEnvironmentKey =
  "SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START";
const realisticPrivateChangedFiles = Object.freeze([
  ".workload-funnel-canary/state/control/runtime-operation.json",
  ".workload-funnel-canary/state/sessions/codex/session-state.jsonl",
  ".workload-funnel-canary/state/cache/codex/app-server/index.json",
]);
const realisticSuccessfulChangedFiles = Object.freeze([
  realisticPrivateChangedFiles[0],
  CANARY_EXPECTED_ARTIFACT_FILE,
  ...realisticPrivateChangedFiles.slice(1),
]);
const cliHelp = `usage:
  subscription-runtime-codex-goal run --job-root <dir> --workspace <dir> --prompt <file> --task-id <id> --accounts account-a,account-b [--tmux-session <name>] [--registry-root <dir>]
  subscription-runtime-codex-goal tools
defaults:
  --model gpt-5.5 --effort high --service-tier default --execution-engine app-server-goal --timeout 72h --app-server-startup-timeout-ms 120000 --max-account-cycles 5
escape hatches:
  --dry-run, --print-command, --no-tmux, --no-require-git-workspace
`;
const toolsCatalog = JSON.stringify({
  tools: [
    {
      description:
        "Start a detached tmux Codex goal worker after explicit confirmation.",
      inputSchema: {
        properties: {
          ...Object.fromEntries(
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
          ),
          accounts: {
            anyOf: [
              { type: "string" },
              { items: { type: "string" }, type: "array" },
            ],
          },
          projectAccessScope: {
            additionalProperties: {},
            propertyNames: { type: "string" },
            type: "object",
          },
        },
        type: "object",
      },
      name: "codex_goal_start",
    },
  ],
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function writePrivate(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
}

async function disposableFixture({
  behavior = "natural_success",
  changedFiles: configuredChangedFiles,
  gitConfig,
  remote = false,
  toolsCatalogOutput = toolsCatalog,
} = {}) {
  const sandboxParent = await mkdtemp(
    join(tmpdir(), "workload-funnel-canary-parent-"),
  );
  roots.push(sandboxParent);
  const projectRoot = join(
    sandboxParent,
    "workload-funnel-disposable-canary-contract-test",
  );
  await mkdir(join(projectRoot, ".git"), { mode: 0o700, recursive: true });
  for (const path of [
    ".git/objects/info",
    ".git/objects/pack",
    ".git/refs/heads",
    ".git/refs/tags",
  ])
    await mkdir(join(projectRoot, path), { mode: 0o700, recursive: true });
  await writePrivate(join(projectRoot, ".git/HEAD"), "ref: refs/heads/main\n");
  await writePrivate(
    join(projectRoot, ".git/config"),
    gitConfig ??
      (remote
        ? '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = /real/project\n'
        : "[core]\n\trepositoryformatversion = 0\n"),
  );
  await writePrivate(
    join(projectRoot, DISPOSABLE_SENTINEL_FILE),
    `${JSON.stringify({
      createdAtMs: Date.now(),
      disposable: true,
      nonce: "0123456789abcdef0123456789abcdef",
      productionStartsEnabled: false,
      purpose: DISPOSABLE_SENTINEL_PURPOSE,
      schemaVersion: 1,
    })}\n`,
  );
  const privateRoot = join(projectRoot, ".workload-funnel-canary");
  const promptPath = join(projectRoot, "hosted-canary-prompt.md");
  const requestPath = join(projectRoot, "hosted-canary-request.json");
  await writePrivate(promptPath, `${CANARY_GOAL_PROMPT}\n`);
  await writePrivate(
    requestPath,
    `${JSON.stringify({
      invocationProfileId: "hosted-canary-profile",
      promptPath,
      schemaVersion: 1,
      taskId: "workload-funnel-hosted-canary-task",
    })}\n`,
  );
  const authRoot = join(sandboxParent, "runtime-owned-auth");
  await mkdir(authRoot, { mode: 0o700 });
  const profilePath = join(sandboxParent, "hosted-canary-profile.json");
  await writePrivate(
    profilePath,
    `${JSON.stringify({
      accessBoundary: "isolated_workspace_write",
      accountSelectors: ["canary-account-a"],
      authRoot,
      executionEngine: "app-server-goal",
      model: "gpt-5.5",
      networkAccess: "restricted",
      profileId: "hosted-canary-profile",
      profileRevision: "revision-1",
      reasoningEffort: "high",
      schemaVersion: 1,
      serviceTier: "default",
    })}\n`,
  );
  const runtimeBinary = join(sandboxParent, "subscription-runtime-codex-goal");
  const changedFiles =
    configuredChangedFiles ??
    (behavior === "unexpected_changed_files"
      ? [CANARY_EXPECTED_ARTIFACT_FILE, "unexpected.txt"]
      : realisticSuccessfulChangedFiles);
  await writeFile(
    runtimeBinary,
    `#!/usr/local/bin/node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.WORKLOAD_FUNNEL_CANARY_STATE_ROOT;
const argv = process.argv.slice(2);
const behavior = ${JSON.stringify(behavior)};
const option = (name) => argv[argv.indexOf(name) + 1];
appendFileSync(join(root, "fake-runtime-argv.jsonl"), JSON.stringify(argv) + "\\n", { mode: 0o600 });
appendFileSync(join(root, "fake-runtime-environment.jsonl"), JSON.stringify({
  argv,
  brokeredStart: Object.hasOwn(process.env, ${JSON.stringify("SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START")})
    ? process.env[${JSON.stringify("SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START")}]
    : null,
}) + "\\n", { mode: 0o600 });
if (argv.length === 1 && argv[0] === "--help") {
  writeFileSync(1, ${JSON.stringify(cliHelp)});
} else if (argv.length === 1 && argv[0] === "tools") {
  writeFileSync(1, ${JSON.stringify(toolsCatalogOutput)});
} else if (argv[0] === "run" && argv[1] === "--no-tmux") {
  writeFileSync(1, "RUNTIME_CREDENTIAL_SENTINEL");
  if (behavior === "timeout" || behavior === "forced_stop") {
    setInterval(() => undefined, 1000);
  } else {
    const workspace = option("--workspace");
    const output = option("--output");
    const taskId = option("--task-id");
    if (behavior !== "missing_artifact") {
      writeFileSync(join(workspace, ${JSON.stringify(CANARY_EXPECTED_ARTIFACT_FILE)}), ${JSON.stringify(CANARY_EXPECTED_ARTIFACT_CONTENT)}, { mode: 0o600 });
    }
    if (behavior === "unexpected_changed_files") {
      writeFileSync(join(workspace, "unexpected.txt"), "unexpected\\n", { mode: 0o600 });
    }
    if (behavior !== "missing_result") {
      const contradictory = behavior === "contradictory_result";
      writeFileSync(output, JSON.stringify({
        blockers: contradictory ? ["synthetic_failure"] : [],
        changedFiles: ${JSON.stringify(changedFiles)},
        evidence: ["safe_execution_status:completed"],
        nextAction: contradictory ? "recover" : "review_completed",
        provider: "codex",
        runId: taskId,
        schemaVersion: 1,
        status: contradictory ? "failed" : "done",
        taskId,
        updatedAt: "2026-07-14T00:00:00.000Z",
      }) + "\\n", { mode: 0o600 });
    }
  }
} else {
  process.exitCode = 2;
}
`,
    { mode: 0o700 },
  );
  await chmod(runtimeBinary, 0o700);
  return {
    authRoot,
    evidencePath: join(privateRoot, "state/hosted-canary-evidence.json"),
    profilePath,
    projectRoot,
    requestPath,
    runtimeBinary,
    sandboxParent,
    stateRoot: join(privateRoot, "state"),
  };
}

function commonArguments(fixture) {
  return [
    "--project-root",
    fixture.projectRoot,
    "--request",
    fixture.requestPath,
    "--runtime-binary",
    fixture.runtimeBinary,
    "--sandbox-parent",
    fixture.sandboxParent,
    "--max-output-bytes",
    "65536",
    "--probe-timeout-ms",
    "60000",
  ];
}

function paddedToolsCatalog(paddingBytes) {
  const catalog = JSON.parse(toolsCatalog);
  catalog.tools[0].description += "x".repeat(paddingBytes);
  return JSON.stringify(catalog);
}

function liveArguments(
  fixture,
  probe,
  {
    foregroundTimeoutMs = 60_000,
    observationWindowMs = 50,
    scenario = "natural_completion",
  } = {},
) {
  return [
    "live",
    ...commonArguments(fixture),
    "--evidence",
    fixture.evidencePath,
    "--expected-cli-help-sha256",
    probe.runtime.cliHelpSha256,
    "--expected-runtime-sha256",
    probe.runtime.binarySha256,
    "--expected-tools-catalog-sha256",
    probe.runtime.toolsCatalogSha256,
    "--foreground-timeout-ms",
    String(foregroundTimeoutMs),
    "--invocation-profile",
    fixture.profilePath,
    "--live-opt-in",
    "WORKLOAD_FUNNEL_DISPOSABLE_CANARY_LIVE",
    "--scenario",
    scenario,
    "--observation-window-ms",
    String(observationWindowMs),
  ];
}

describe("hosted canary command", { timeout: 120_000 }, () => {
  test("runs one contract-faithful fake foreground child with runtime-owned auth", async () => {
    const fixture = await disposableFixture();
    const project = await validateDisposableProject({
      maximumAgeMs: 60 * 60_000,
      nowMs: Date.now(),
      projectRoot: fixture.projectRoot,
      requestPath: fixture.requestPath,
      sandboxParent: fixture.sandboxParent,
      workspaceRoot: process.cwd(),
    });
    const directRunner = createNodeHostedCanaryProcessRunner();
    const identity = await directRunner.inspectExecutable(
      fixture.runtimeBinary,
    );
    const directHelp = await directRunner.run({
      argv: ["--help"],
      cwd: fixture.projectRoot,
      environment: canaryEnvironment(project),
      executable: fixture.runtimeBinary,
      expectedExecutableIdentity: identity,
      maxOutputBytes: 65_536,
      timeoutMs: 60_000,
    });
    expect(directHelp).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: cliHelp,
      timedOut: false,
    });

    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      { [brokeredStartEnvironmentKey]: "caller-probe-value" },
    );
    expect(probe.outcome).toBe("probe_only");
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      {
        [brokeredStartEnvironmentKey]: "caller-foreground-value",
        WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1",
      },
    );

    expect(evidence).toMatchObject({
      mode: "live",
      operations: {
        completionMode: "natural_completion",
        expectedArtifact: {
          path: CANARY_EXPECTED_ARTIFACT_FILE,
          verified: true,
        },
        foregroundExitCode: 0,
        foregroundStart: "accepted",
        foregroundTimedOut: false,
        outerTermination: "not_requested",
        terminalResultStatus: "done",
      },
      outcome: "passed",
      productionStartsEnabled: false,
      safety: {
        credentialMaterialReadByHarness: false,
        foregroundOutputCaptured: false,
        foregroundModeRequiresNoTmux: true,
        shellUsed: false,
        startToolInvoked: false,
      },
    });
    const durableEvidence = await readFile(fixture.evidencePath, "utf8");
    for (const forbidden of [
      "RUNTIME_CREDENTIAL_SENTINEL",
      fixture.authRoot,
      "canary-account-a",
      "hosted-canary-profile",
      ...realisticPrivateChangedFiles,
    ])
      expect(durableEvidence).not.toContain(forbidden);

    const invocations = (
      await readFile(join(fixture.stateRoot, "fake-runtime-argv.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const foregroundInvocations = invocations.filter(
      (argv) => argv[0] === "run" && argv[1] === "--no-tmux",
    );
    expect(foregroundInvocations).toHaveLength(1);
    const foreground = foregroundInvocations[0];
    for (const option of [
      "--job-root",
      "--auth-root",
      "--workspace",
      "--prompt",
      "--task-id",
      "--accounts",
      "--registry-root",
      "--output",
      "--progress",
      "--model",
      "--effort",
      "--service-tier",
      "--access-boundary",
      "--project-access-scope-json",
    ])
      expect(foreground).toContain(option);
    expect(invocations.some((argv) => argv[0] === "tool")).toBe(false);
    expect(invocations.some((argv) => argv.includes("codex_goal_start"))).toBe(
      false,
    );
    expect(invocations.some((argv) => argv.includes("tmux"))).toBe(false);
    const childEnvironments = (
      await readFile(
        join(fixture.stateRoot, "fake-runtime-environment.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const foregroundEnvironments = childEnvironments.filter(
      ({ argv }) => argv[0] === "run" && argv[1] === "--no-tmux",
    );
    const probeEnvironments = childEnvironments.filter(
      ({ argv }) =>
        argv.length === 1 && (argv[0] === "--help" || argv[0] === "tools"),
    );
    expect(foregroundEnvironments).toHaveLength(1);
    expect(foregroundEnvironments[0].brokeredStart).toBe("1");
    expect(probeEnvironments.length).toBeGreaterThan(0);
    expect(
      probeEnvironments.every(({ brokeredStart }) => brokeredStart === null),
    ).toBe(true);
    expect(JSON.stringify(childEnvironments)).not.toContain(
      "caller-probe-value",
    );
    expect(JSON.stringify(childEnvironments)).not.toContain(
      "caller-foreground-value",
    );

    const operationWal = await readFile(
      join(fixture.stateRoot, "bridge-operations/runtime-operations.wal"),
      "utf8",
    );
    expect(operationWal).not.toContain(fixture.authRoot);
    expect(operationWal).not.toContain("canary-account-a");
  }, 120_000);

  test("refuses a project with a remote before invoking the executable", async () => {
    const fixture = await disposableFixture({ remote: true });
    await expect(
      runHostedCanaryCommand(["probe", ...commonArguments(fixture)], {}),
    ).rejects.toThrow("hosted_canary_git_remote_forbidden");
    await expect(
      access(join(fixture.stateRoot, "fake-runtime-argv.jsonl")),
    ).rejects.toThrow();
  }, 120_000);

  test("refuses executable git configuration before invoking the runtime", async () => {
    const fixture = await disposableFixture({
      gitConfig:
        "[core]\n\trepositoryformatversion = 0\n\tfsmonitor = /untrusted/hook\n",
    });
    await expect(
      runHostedCanaryCommand(["probe", ...commonArguments(fixture)], {}),
    ).rejects.toThrow("hosted_canary_disposable_git_config_invalid");
    await expect(
      access(join(fixture.stateRoot, "fake-runtime-argv.jsonl")),
    ).rejects.toThrow();
  });

  test("fails closed when natural completion reaches its outer timeout", async () => {
    const fixture = await disposableFixture({ behavior: "timeout" });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe, { foregroundTimeoutMs: 100 }),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_foreground_timeout",
      operations: {
        completionMode: "natural_completion",
        foregroundTimedOut: true,
        outerTermination: "timeout_kill",
        terminalResultStatus: null,
      },
      outcome: "unknown",
    });
  }, 120_000);

  test("rejects a contradictory structured terminal result", async () => {
    const fixture = await disposableFixture({
      behavior: "contradictory_result",
    });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_contradictory",
      operations: { completionMode: "natural_completion" },
      outcome: "unknown",
    });
  });

  test("rejects unexpected changed files from the terminal result", async () => {
    const fixture = await disposableFixture({
      behavior: "unexpected_changed_files",
    });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_unexpected_paths",
      outcome: "unknown",
    });
  });

  test.each([
    [
      "the private root itself",
      [CANARY_EXPECTED_ARTIFACT_FILE, ".workload-funnel-canary"],
    ],
    [
      "a private-root near-prefix",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary-evil/state/control.json",
      ],
    ],
    [
      "private traversal",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/state/../secrets.json",
      ],
    ],
    [
      "a private dot segment",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/./state/control.json",
      ],
    ],
    [
      "a repeated private separator",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/state//control.json",
      ],
    ],
    [
      "a private path containing a backslash",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/state\\control.json",
      ],
    ],
    [
      "a duplicate private path",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        realisticPrivateChangedFiles[0],
        realisticPrivateChangedFiles[0],
      ],
    ],
    ["an empty path", [CANARY_EXPECTED_ARTIFACT_FILE, ""]],
    [
      "a control-character path",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/state/control\nrecord.json",
      ],
    ],
    [
      "an absolute path",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        "/.workload-funnel-canary/state/control.json",
      ],
    ],
    [
      "a Windows absolute path",
      [CANARY_EXPECTED_ARTIFACT_FILE, "C:/runtime/control.json"],
    ],
    [
      "a non-normalized Unicode path",
      [
        CANARY_EXPECTED_ARTIFACT_FILE,
        ".workload-funnel-canary/state/cafe\u0301.json",
      ],
    ],
  ])(
    "rejects %s in the terminal changed-file list",
    async (_, changedFiles) => {
      const fixture = await disposableFixture({ changedFiles });
      const probe = await runHostedCanaryCommand(
        ["probe", ...commonArguments(fixture)],
        {},
      );
      const evidence = await runHostedCanaryCommand(
        liveArguments(fixture, probe),
        { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
      );
      expect(evidence).toMatchObject({
        failureCode: "hosted_canary_terminal_result_unexpected_paths",
        outcome: "unknown",
      });
    },
  );

  test("rejects a malformed non-string terminal changed-file entry", async () => {
    const fixture = await disposableFixture({
      changedFiles: [CANARY_EXPECTED_ARTIFACT_FILE, null],
    });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_invalid",
      outcome: "unknown",
    });
  });

  test("rejects a terminal changed-file entry over the per-item bound", async () => {
    const fixture = await disposableFixture({
      changedFiles: [
        CANARY_EXPECTED_ARTIFACT_FILE,
        `.workload-funnel-canary/state/${"x".repeat(8 * 1024)}.json`,
      ],
    });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_invalid",
      outcome: "unknown",
    });
  });

  test("rejects a terminal changed-file total over the finite item cap", async () => {
    const privateChangedFiles = Array.from(
      { length: HOSTED_CANARY_CHANGED_FILES_MAX_ITEMS },
      (_, index) =>
        `.workload-funnel-canary/state/count-bound/entry-${index}.json`,
    );
    const changedFiles = [
      CANARY_EXPECTED_ARTIFACT_FILE,
      ...privateChangedFiles,
    ];
    expect(changedFiles).toHaveLength(
      HOSTED_CANARY_CHANGED_FILES_MAX_ITEMS + 1,
    );
    expect(Buffer.byteLength(JSON.stringify({ changedFiles }))).toBeLessThan(
      HOSTED_CANARY_TERMINAL_RESULT_MAX_BYTES,
    );
    const fixture = await disposableFixture({ changedFiles });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_invalid",
      outcome: "unknown",
    });
    const serializedEvidence = `${JSON.stringify(evidence)}\n`;
    const durableEvidence = await readFile(fixture.evidencePath, "utf8");
    expect(Buffer.byteLength(serializedEvidence)).toBeLessThan(16 * 1024);
    expect(Buffer.byteLength(durableEvidence)).toBeLessThan(16 * 1024);
    for (const privateChangedFile of [
      privateChangedFiles[0],
      privateChangedFiles.at(-1),
    ]) {
      expect(serializedEvidence).not.toContain(privateChangedFile);
      expect(durableEvidence).not.toContain(privateChangedFile);
    }
  });

  test("rejects a missing expected artifact after a successful result", async () => {
    const fixture = await disposableFixture({ behavior: "missing_artifact" });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_expected_artifact_missing",
      outcome: "unknown",
    });
  });

  test("rejects a missing structured terminal result", async () => {
    const fixture = await disposableFixture({ behavior: "missing_result" });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      failureCode: "hosted_canary_terminal_result_missing",
      outcome: "unknown",
    });
  });

  test("keeps explicit forced stop separate from natural completion", async () => {
    const fixture = await disposableFixture({ behavior: "forced_stop" });
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const evidence = await runHostedCanaryCommand(
      liveArguments(fixture, probe, {
        observationWindowMs: 500,
        scenario: "forced_stop",
      }),
      { WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1" },
    );
    expect(evidence).toMatchObject({
      operations: {
        completionMode: "forced_stop",
        expectedArtifact: null,
        foregroundExitedBeforeStop: false,
        foregroundStart: "accepted",
        foregroundTimedOut: false,
        outerTermination: "completed",
        terminalResultStatus: null,
      },
      outcome: "passed",
    });
    const invocations = (
      await readFile(join(fixture.stateRoot, "fake-runtime-argv.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      invocations.filter(
        (argv) => argv[0] === "run" && argv[1] === "--no-tmux",
      ),
    ).toHaveLength(1);
  }, 120_000);

  test("requires both live opt-ins before the trusted profile or foreground start", async () => {
    const fixture = await disposableFixture();
    const probe = await runHostedCanaryCommand(
      ["probe", ...commonArguments(fixture)],
      {},
    );
    const before = await readFile(
      join(fixture.stateRoot, "fake-runtime-argv.jsonl"),
      "utf8",
    );
    await expect(
      runHostedCanaryCommand(liveArguments(fixture, probe), {}),
    ).rejects.toThrow("hosted_canary_live_opt_in_missing");
    const relativeProfileArguments = liveArguments(fixture, probe);
    relativeProfileArguments[
      relativeProfileArguments.indexOf("--invocation-profile") + 1
    ] = "hosted-canary-profile.json";
    await expect(
      runHostedCanaryCommand(relativeProfileArguments, {
        WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1",
      }),
    ).rejects.toThrow("hosted_canary_absolute_path_required");
    expect(
      await readFile(
        join(fixture.stateRoot, "fake-runtime-argv.jsonl"),
        "utf8",
      ),
    ).toBe(before);
  });

  test("bounds probe output and kills the disposable process group", async () => {
    const fixture = await disposableFixture();
    const project = await validateDisposableProject({
      maximumAgeMs: 60 * 60_000,
      nowMs: Date.now(),
      projectRoot: fixture.projectRoot,
      requestPath: fixture.requestPath,
      sandboxParent: fixture.sandboxParent,
      workspaceRoot: process.cwd(),
    });
    const noisy = join(fixture.sandboxParent, "noisy-runtime");
    await writeFile(
      noisy,
      '#!/usr/local/bin/node\nsetInterval(() => process.stdout.write("x".repeat(2048)), 10);\n',
      { mode: 0o700 },
    );
    const runner = createNodeHostedCanaryProcessRunner();
    const identity = await runner.inspectExecutable(noisy);
    await expect(
      runner.run({
        argv: ["--help"],
        cwd: fixture.projectRoot,
        environment: canaryEnvironment(project),
        executable: noisy,
        expectedExecutableIdentity: identity,
        maxOutputBytes: 1024,
        timeoutMs: 500,
      }),
    ).resolves.toEqual({
      exitCode: null,
      stderr: "",
      stdout: "",
      timedOut: true,
    });
  }, 120_000);

  test("fails closed when a valid catalog exceeds the selected output bound", async () => {
    const oversizedCatalog = paddedToolsCatalog(128 * 1024);
    expect(Buffer.byteLength(oversizedCatalog)).toBeGreaterThan(128 * 1024);
    const fixture = await disposableFixture({
      toolsCatalogOutput: oversizedCatalog,
    });
    const arguments_ = commonArguments(fixture);
    arguments_[arguments_.indexOf("--max-output-bytes") + 1] = String(
      128 * 1024,
    );

    await expect(
      runHostedCanaryCommand(["probe", ...arguments_], {}),
    ).rejects.toThrow("hosted_canary_capability_probe_failed");
  }, 120_000);

  test("fails closed when a valid catalog exceeds the hard output cap", async () => {
    const oversizedCatalog = paddedToolsCatalog(2 * 1024 * 1024);
    expect(Buffer.byteLength(oversizedCatalog)).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    const fixture = await disposableFixture({
      toolsCatalogOutput: oversizedCatalog,
    });
    const arguments_ = commonArguments(fixture);
    arguments_[arguments_.indexOf("--max-output-bytes") + 1] = String(
      2 * 1024 * 1024,
    );

    await expect(
      runHostedCanaryCommand(["probe", ...arguments_], {}),
    ).rejects.toThrow("hosted_canary_capability_probe_failed");
  }, 120_000);
});
