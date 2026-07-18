import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test } from "vitest";

import { assertFinalOutcome, validateChecksumInventory } from "./artifacts.mjs";
import { hostedContext } from "./contract.mjs";

const execFileAsync = promisify(execFile);
const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => undefined);
      for (const name of await readdir(root).catch(() => []))
        await chmod(`${root}/${name}`, 0o700).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }),
  );
});

function stepScript(workflow, stepName) {
  const start = workflow.indexOf(`      - name: ${stepName}\n`);
  if (start < 0) throw new Error("workflow_step_missing");
  const end = workflow.indexOf("\n      - name:", start + 1);
  const block = workflow.slice(start, end < 0 ? undefined : end);
  const marker = "        run: |\n";
  const scriptStart = block.indexOf(marker);
  if (scriptStart < 0) throw new Error("workflow_step_script_missing");
  return block
    .slice(scriptStart + marker.length)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

const PHASES = Object.freeze([
  ["INITIALIZATION_OUTCOME", "initialize"],
  ["CHECKOUT_OUTCOME", "checkout"],
  ["CONTEXT_OUTCOME", "context"],
  ["COMMIT_OUTCOME", "commit-binding"],
  ["NODE_OUTCOME", "node-setup"],
  ["INSTALL_OUTCOME", "dependency-install"],
  ["BUILD_OUTCOME", "build"],
  ["PREPARE_OUTCOME", "host-prepare"],
  ["GATE_OUTCOME", "production-gate"],
  ["CLEANUP_FIRST_OUTCOME", "cleanup-1"],
  ["CLEANUP_SECOND_OUTCOME", "cleanup-2"],
  ["TEARDOWN_OUTCOME", "host-teardown"],
  ["RESIDUE_OUTCOME", "residue"],
  ["WORKFLOW_STATUS_OUTCOME", "workflow-status"],
  ["PACKAGE_OUTCOME", "package"],
]);

test("the exact fallback artifact stays checksummed and BLOCKED for every failure phase", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  const script = stepScript(workflow, "Seal fail-closed fallback evidence");
  expect(workflow).toContain(
    "sudo -n --preserve-env=GITHUB_WORKSPACE,GITHUB_SHA,GITHUB_RUN_ID,GITHUB_RUN_ATTEMPT,RUNNER_TEMP",
  );
  for (const [index, [failedOutcome, blockedPhase]] of PHASES.entries()) {
    const runnerTemp = await mkdtemp(
      join(tmpdir(), "hosted-fallback-artifact-"),
    );
    roots.push(runnerTemp);
    const outcomes = Object.fromEntries(
      PHASES.map(([name]) => [name, "success"]),
    );
    outcomes[failedOutcome] = "failure";
    const environment = {
      ...process.env,
      ...outcomes,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: String(700_000 + index),
      GITHUB_SHA: "a".repeat(40),
      GITHUB_WORKSPACE: process.cwd(),
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      RUNNER_TEMP: runnerTemp,
    };
    await execFileAsync("/bin/bash", ["-c", script], { env: environment });
    const context = hostedContext(environment);
    await expect(validateChecksumInventory(context)).resolves.toBeUndefined();
    const verdict = JSON.parse(
      await readFile(`${context.artifactRoot}/hosted-verdict.json`, "utf8"),
    );
    expect(verdict).toMatchObject({
      blockedPhase,
      commit: context.commit,
      overallVerdict: "BLOCKED",
      runAttempt: context.runAttempt,
      runId: context.runNumber,
    });
    await expect(assertFinalOutcome(context)).rejects.toThrow(
      "hosted_verdict_blocked",
    );
    expect((await stat(context.artifactRoot)).mode & 0o777).toBe(0o555);
  }
}, 30_000);
