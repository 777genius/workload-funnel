import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import assert from "node:assert/strict";
import test from "node:test";

import {
  CANARY_EXPECTED_ARTIFACT_CONTENT,
  CANARY_EXPECTED_ARTIFACT_FILE,
  CANARY_GOAL_PROMPT,
  DISPOSABLE_SENTINEL_FILE,
  DISPOSABLE_SENTINEL_PURPOSE,
} from "./disposable-project.mjs";

const entrypoint = join(import.meta.dirname, "run.mjs");
const brokeredStartEnvironmentKey =
  "SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START";
const realisticPrivateChangedFiles = [
  ".workload-funnel-canary/state/control/runtime-operation.json",
  ".workload-funnel-canary/state/sessions/codex/session-state.jsonl",
  ".workload-funnel-canary/state/cache/codex/app-server/index.json",
  ...Array.from(
    { length: 180 },
    (_, index) =>
      `.workload-funnel-canary/state/sessions/codex/session-${String(index).padStart(3, "0")}/events.jsonl`,
  ),
];
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
        "Start a detached tmux Codex goal worker after explicit confirmation." +
        "x".repeat(144 * 1024),
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

async function writePrivate(path, contents) {
  await writeFile(path, contents, { mode: 0o600 });
}

async function createDisposableFixture(t) {
  const sandboxParent = await mkdtemp(
    join(tmpdir(), "workload-funnel-standalone-probe-"),
  );
  t.after(() => rm(sandboxParent, { force: true, recursive: true }));
  const projectRoot = join(
    sandboxParent,
    "workload-funnel-disposable-canary-standalone-probe",
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
    "[core]\n\trepositoryformatversion = 0\n",
  );
  await writePrivate(
    join(projectRoot, DISPOSABLE_SENTINEL_FILE),
    `${JSON.stringify({
      createdAtMs: Date.now(),
      disposable: true,
      nonce: "fedcba9876543210fedcba9876543210",
      productionStartsEnabled: false,
      purpose: DISPOSABLE_SENTINEL_PURPOSE,
      schemaVersion: 1,
    })}\n`,
  );
  const promptPath = join(projectRoot, "hosted-canary-prompt.md");
  const requestPath = join(projectRoot, "hosted-canary-request.json");
  await writePrivate(promptPath, `${CANARY_GOAL_PROMPT}\n`);
  await writePrivate(
    requestPath,
    `${JSON.stringify({
      invocationProfileId: "synthetic-standalone-probe",
      promptPath,
      schemaVersion: 1,
      taskId: "synthetic-standalone-probe-task",
    })}\n`,
  );
  const authRoot = join(sandboxParent, "runtime-owned-auth");
  await mkdir(authRoot, { mode: 0o700 });
  const profilePath = join(sandboxParent, "standalone-profile.json");
  await writePrivate(
    profilePath,
    `${JSON.stringify({
      accessBoundary: "isolated_workspace_write",
      accountSelectors: ["synthetic-canary-account"],
      authRoot,
      executionEngine: "app-server-goal",
      model: "gpt-5.5",
      networkAccess: "restricted",
      profileId: "synthetic-standalone-probe",
      profileRevision: "standalone-revision-1",
      reasoningEffort: "high",
      schemaVersion: 1,
      serviceTier: "default",
    })}\n`,
  );
  const runtimeBinary = join(sandboxParent, "subscription-runtime-codex-goal");
  await writeFile(
    runtimeBinary,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const option = (name) => argv[argv.indexOf(name) + 1];
appendFileSync(
  join(process.env.WORKLOAD_FUNNEL_CANARY_STATE_ROOT, "standalone-probe-argv.jsonl"),
  JSON.stringify(argv) + "\\n",
  { mode: 0o600 },
);
appendFileSync(
  join(process.env.WORKLOAD_FUNNEL_CANARY_STATE_ROOT, "standalone-child-environment.jsonl"),
  JSON.stringify({
    argv,
    brokeredStart: Object.hasOwn(process.env, ${JSON.stringify("SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START")})
      ? process.env[${JSON.stringify("SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START")}]
      : null,
  }) + "\\n",
  { mode: 0o600 },
);
if (argv.length === 1 && argv[0] === "--help") {
  writeFileSync(1, ${JSON.stringify(cliHelp)});
} else if (argv.length === 1 && argv[0] === "tools") {
  writeFileSync(1, ${JSON.stringify(toolsCatalog)});
} else if (argv[0] === "run" && argv[1] === "--no-tmux") {
  if (process.env[${JSON.stringify("SUBSCRIPTION_RUNTIME_PROJECT_CONTROL_BROKERED_START")}] !== "1") {
    process.exitCode = 98;
  } else {
    const output = option("--output");
    const taskId = option("--task-id");
    writeFileSync(
      join(option("--workspace"), ${JSON.stringify(CANARY_EXPECTED_ARTIFACT_FILE)}),
      ${JSON.stringify(CANARY_EXPECTED_ARTIFACT_CONTENT)},
      { mode: 0o600 },
    );
    writeFileSync(output, JSON.stringify({
      blockers: [],
      changedFiles: ${JSON.stringify([
        realisticPrivateChangedFiles[0],
        CANARY_EXPECTED_ARTIFACT_FILE,
        ...realisticPrivateChangedFiles.slice(1),
      ])},
      evidence: ["safe_execution_status:completed"],
      nextAction: "review_completed",
      provider: "codex",
      runId: taskId,
      schemaVersion: 1,
      status: "done",
      taskId,
      updatedAt: "2026-07-14T00:00:00.000Z",
    }) + "\\n", { mode: 0o600 });
  }
} else {
  process.exitCode = 97;
}
`,
    { mode: 0o700 },
  );
  await chmod(runtimeBinary, 0o700);
  return {
    invocationLog: join(
      projectRoot,
      ".workload-funnel-canary/state/standalone-probe-argv.jsonl",
    ),
    childEnvironmentLog: join(
      projectRoot,
      ".workload-funnel-canary/state/standalone-child-environment.jsonl",
    ),
    evidencePath: join(
      projectRoot,
      ".workload-funnel-canary/state/hosted-canary-evidence.json",
    ),
    profilePath,
    projectRoot,
    requestPath,
    runtimeBinary,
    sandboxParent,
  };
}

test("the standalone entrypoint keeps brokered start foreground-only", async (t) => {
  assert.ok(Buffer.byteLength(toolsCatalog) > 128 * 1024);
  assert.ok(Buffer.byteLength(toolsCatalog) < 256 * 1024);
  const fixture = await createDisposableFixture(t);
  const stdoutPath = join(fixture.sandboxParent, "standalone-stdout.json");
  const stderrPath = join(fixture.sandboxParent, "standalone-stderr.log");
  const stdout = openSync(stdoutPath, "wx", 0o600);
  const stderr = openSync(stderrPath, "wx", 0o600);
  let result;
  try {
    result = spawnSync(
      process.execPath,
      [
        entrypoint,
        "probe",
        "--project-root",
        fixture.projectRoot,
        "--request",
        fixture.requestPath,
        "--runtime-binary",
        fixture.runtimeBinary,
        "--sandbox-parent",
        fixture.sandboxParent,
        "--probe-timeout-ms",
        "60000",
      ],
      {
        cwd: dirname(entrypoint),
        env: {
          [brokeredStartEnvironmentKey]: "caller-probe-value",
          HOME: fixture.sandboxParent,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TMPDIR: fixture.sandboxParent,
        },
        killSignal: "SIGKILL",
        stdio: ["ignore", stdout, stderr],
        timeout: 120_000,
        windowsHide: true,
      },
    );
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, await readFile(stderrPath, "utf8"));
  assert.equal(await readFile(stderrPath, "utf8"), "");
  const evidence = JSON.parse(await readFile(stdoutPath, "utf8"));
  assert.equal(evidence.mode, "probe");
  assert.equal(evidence.outcome, "probe_only");
  assert.equal(evidence.productionStartsEnabled, false);
  assert.equal(evidence.safety.startToolInvoked, false);
  assert.equal(
    evidence.runtime.binarySha256,
    await sha256(fixture.runtimeBinary),
  );
  const invocations = (await readFile(fixture.invocationLog, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(invocations, [["--help"], ["tools"]]);
  const probeChildEnvironments = (
    await readFile(fixture.childEnvironmentLog, "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    probeChildEnvironments.map(({ brokeredStart }) => brokeredStart),
    [null, null],
  );

  const liveStdoutPath = join(
    fixture.sandboxParent,
    "standalone-live-stdout.json",
  );
  const liveStderrPath = join(
    fixture.sandboxParent,
    "standalone-live-stderr.log",
  );
  const liveStdout = openSync(liveStdoutPath, "wx", 0o600);
  const liveStderr = openSync(liveStderrPath, "wx", 0o600);
  let liveResult;
  try {
    liveResult = spawnSync(
      process.execPath,
      [
        entrypoint,
        "live",
        "--project-root",
        fixture.projectRoot,
        "--request",
        fixture.requestPath,
        "--runtime-binary",
        fixture.runtimeBinary,
        "--sandbox-parent",
        fixture.sandboxParent,
        "--evidence",
        fixture.evidencePath,
        "--expected-cli-help-sha256",
        evidence.runtime.cliHelpSha256,
        "--expected-runtime-sha256",
        evidence.runtime.binarySha256,
        "--expected-tools-catalog-sha256",
        evidence.runtime.toolsCatalogSha256,
        "--foreground-timeout-ms",
        "60000",
        "--invocation-profile",
        fixture.profilePath,
        "--live-opt-in",
        "WORKLOAD_FUNNEL_DISPOSABLE_CANARY_LIVE",
        "--probe-timeout-ms",
        "60000",
        "--scenario",
        "natural_completion",
      ],
      {
        cwd: dirname(entrypoint),
        env: {
          [brokeredStartEnvironmentKey]: "caller-live-value",
          HOME: fixture.sandboxParent,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TMPDIR: fixture.sandboxParent,
          WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE: "1",
        },
        killSignal: "SIGKILL",
        stdio: ["ignore", liveStdout, liveStderr],
        timeout: 120_000,
        windowsHide: true,
      },
    );
  } finally {
    closeSync(liveStdout);
    closeSync(liveStderr);
  }

  assert.equal(liveResult.error, undefined);
  assert.equal(liveResult.signal, null);
  assert.equal(liveResult.status, 0, await readFile(liveStderrPath, "utf8"));
  assert.equal(await readFile(liveStderrPath, "utf8"), "");
  const liveEvidence = JSON.parse(await readFile(liveStdoutPath, "utf8"));
  assert.equal(liveEvidence.mode, "live");
  assert.equal(liveEvidence.outcome, "passed");
  assert.equal(liveEvidence.operations.foregroundStart, "accepted");
  assert.equal(liveEvidence.operations.foregroundExitCode, 0);
  assert.equal(liveEvidence.productionStartsEnabled, false);
  const durableEvidence = await readFile(fixture.evidencePath, "utf8");
  const liveStdoutContents = await readFile(liveStdoutPath, "utf8");
  assert.ok(realisticPrivateChangedFiles.length > 128);
  assert.equal(realisticPrivateChangedFiles.length + 1, 184);
  for (const privateChangedFile of realisticPrivateChangedFiles) {
    assert.equal(durableEvidence.includes(privateChangedFile), false);
    assert.equal(liveStdoutContents.includes(privateChangedFile), false);
  }

  const childEnvironments = (
    await readFile(fixture.childEnvironmentLog, "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const readEnvironments = childEnvironments.filter(
    ({ argv }) =>
      argv.length === 1 && (argv[0] === "--help" || argv[0] === "tools"),
  );
  const foregroundEnvironments = childEnvironments.filter(
    ({ argv }) => argv[0] === "run" && argv[1] === "--no-tmux",
  );
  assert.ok(readEnvironments.length > 0);
  assert.ok(
    readEnvironments.every(({ brokeredStart }) => brokeredStart === null),
  );
  assert.equal(foregroundEnvironments.length, 1);
  assert.equal(foregroundEnvironments[0].brokeredStart, "1");
  assert.equal(
    JSON.stringify(childEnvironments).includes("caller-probe-value"),
    false,
  );
  assert.equal(
    JSON.stringify(childEnvironments).includes("caller-live-value"),
    false,
  );
});

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
