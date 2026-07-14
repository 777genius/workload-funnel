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
  CANARY_GOAL_PROMPT,
  DISPOSABLE_SENTINEL_FILE,
  DISPOSABLE_SENTINEL_PURPOSE,
} from "./disposable-project.mjs";

const entrypoint = join(import.meta.dirname, "run.mjs");
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
  const runtimeBinary = join(sandboxParent, "synthetic-runtime");
  await writeFile(
    runtimeBinary,
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
appendFileSync(
  join(process.env.WORKLOAD_FUNNEL_CANARY_STATE_ROOT, "standalone-probe-argv.jsonl"),
  JSON.stringify(argv) + "\\n",
  { mode: 0o600 },
);
if (argv.length === 1 && argv[0] === "--help") {
  writeFileSync(1, ${JSON.stringify(cliHelp)});
} else if (argv.length === 1 && argv[0] === "tools") {
  writeFileSync(1, ${JSON.stringify(toolsCatalog)});
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
    projectRoot,
    requestPath,
    runtimeBinary,
    sandboxParent,
  };
}

test("the standalone hosted canary entrypoint resolves packages and probes only", async (t) => {
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
});

async function sha256(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}
