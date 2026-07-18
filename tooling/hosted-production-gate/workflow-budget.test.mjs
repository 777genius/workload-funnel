import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { expect, test } from "vitest";

import { INVOCATION_TIMEOUT_MS } from "./gate-invocation.mjs";

const REQUIRED_STEPS = Object.freeze([
  "Initialize evidence directory",
  "Check out exact source",
  "Record hosted context",
  "Bind dispatch input to exact checked-out commit",
  "Set up exact Node.js",
  "Install exact dependencies",
  "Build exact checked-out commit",
  "Prove and prepare disposable host",
  "Run production gate once",
  "Recover cleanup first pass",
  "Recover cleanup second pass",
  "Remove hosted bootstrap state",
  "Verify zero owned residue",
  "Record workflow phase outcomes",
  "Seal checksummed evidence package",
  "Seal fail-closed fallback evidence",
  "Upload immutable production-gate evidence",
  "Enforce fail-closed verdict",
]);

function refuse(condition, code) {
  if (condition) throw new Error(code);
}

function stepBlocks(job) {
  const starts = [...job.matchAll(/^ {6}- name: (.+)$/gmu)];
  return starts.map((match, index) => ({
    block: job.slice(
      match.index,
      starts[index + 1]?.index === undefined
        ? undefined
        : starts[index + 1].index,
    ),
    name: match[1],
  }));
}

function auditBudget(workflow, invocationTimeouts = INVOCATION_TIMEOUT_MS) {
  const jobStart = workflow.indexOf("  production-readiness:");
  refuse(jobStart < 0, "production_job_missing");
  const job = workflow.slice(jobStart);
  const stepsStart = job.indexOf("    steps:");
  refuse(stepsStart < 0, "production_steps_missing");
  const jobTimeout = job
    .slice(0, stepsStart)
    .match(/^ {4}timeout-minutes: ([1-9][0-9]*)$/mu);
  refuse(jobTimeout === null, "job_timeout_missing");
  const jobMinutes = Number(jobTimeout[1]);
  const steps = stepBlocks(job);
  refuse(
    steps.length !== REQUIRED_STEPS.length ||
      steps.some((step, index) => step.name !== REQUIRED_STEPS[index]),
    "production_step_inventory_invalid",
  );
  const budgets = new Map();
  for (const step of steps) {
    const matches = [
      ...step.block.matchAll(/^ {8}timeout-minutes: ([1-9][0-9]*)$/gmu),
    ];
    refuse(matches.length !== 1, `step_timeout_invalid:${step.name}`);
    budgets.set(step.name, Number(matches[0][1]));
  }
  const totalMinutes = [...budgets.values()].reduce(
    (total, value) => total + value,
    0,
  );
  refuse(totalMinutes >= jobMinutes, "workflow_timeout_budget_exhausted");

  const invocationSteps = Object.freeze({
    "cleanup-1": "Recover cleanup first pass",
    "cleanup-2": "Recover cleanup second pass",
    gate: "Run production gate once",
  });
  for (const [invocation, stepName] of Object.entries(invocationSteps)) {
    const internal = invocationTimeouts[invocation];
    refuse(
      !Number.isSafeInteger(internal) ||
        internal < 1 ||
        internal >= budgets.get(stepName) * 60_000,
      `invocation_timeout_margin_invalid:${invocation}`,
    );
  }

  for (const name of [
    "Run production gate once",
    "Recover cleanup first pass",
    "Recover cleanup second pass",
    "Seal fail-closed fallback evidence",
    "Upload immutable production-gate evidence",
  ]) {
    const step = steps.find((candidate) => candidate.name === name);
    refuse(
      !step.block.includes("if: always()"),
      `always_chain_invalid:${name}`,
    );
  }
  for (const name of [
    "Run production gate once",
    "Recover cleanup first pass",
    "Recover cleanup second pass",
  ]) {
    const step = steps.find((candidate) => candidate.name === name);
    refuse(
      !step.block.includes("continue-on-error: true"),
      `timeout_continuation_invalid:${name}`,
    );
  }
  return Object.freeze({ budgets, jobMinutes, totalMinutes });
}

const workflowPath = fileURLToPath(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
);

test("reserves cleanup, fallback sealing, and upload time below the job deadline", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const budget = auditBudget(workflow);
  expect(budget.jobMinutes).toBe(300);
  expect(budget.totalMinutes).toBe(285);
  expect(budget.jobMinutes - budget.totalMinutes).toBe(15);
  for (const name of [
    "Check out exact source",
    "Set up exact Node.js",
    "Install exact dependencies",
    "Build exact checked-out commit",
    "Prove and prepare disposable host",
    "Remove hosted bootstrap state",
    "Verify zero owned residue",
    "Seal checksummed evidence package",
    "Seal fail-closed fallback evidence",
    "Upload immutable production-gate evidence",
  ])
    expect(budget.budgets.get(name)).toBeGreaterThan(0);
});

test("rejects missing early-step and exhausted aggregate timeout budgets", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const missingInstallTimeout = workflow.replace(
    "      - name: Install exact dependencies\n        id: install\n        if: always()\n        timeout-minutes: 15\n",
    "      - name: Install exact dependencies\n        id: install\n        if: always()\n",
  );
  expect(() => auditBudget(missingInstallTimeout)).toThrow(
    "step_timeout_invalid:Install exact dependencies",
  );
  const exhausted = workflow.replace(
    "    timeout-minutes: 300\n    steps:",
    "    timeout-minutes: 285\n    steps:",
  );
  expect(() => auditBudget(exhausted)).toThrow(
    "workflow_timeout_budget_exhausted",
  );
});

test("rejects phase deadlines without an outer-step margin or always continuation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  expect(() =>
    auditBudget(workflow, {
      ...INVOCATION_TIMEOUT_MS,
      gate: 95 * 60_000,
    }),
  ).toThrow("invocation_timeout_margin_invalid:gate");
  const interruptedChain = workflow.replace(
    "      - name: Recover cleanup first pass\n        id: cleanup_first\n        if: always()\n",
    "      - name: Recover cleanup first pass\n        id: cleanup_first\n",
  );
  expect(() => auditBudget(interruptedChain)).toThrow(
    "always_chain_invalid:Recover cleanup first pass",
  );
});
