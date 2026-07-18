import { Buffer } from "node:buffer";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  packageArtifacts,
  REQUIRED_OUTPUTS,
  validateChecksumInventory,
} from "./artifacts.mjs";
import { sha256 } from "./contract.mjs";
import { sha256Sums } from "./review-manifest.mjs";

let root;

afterEach(async () => {
  if (root !== undefined) await rm(root, { force: true, recursive: true });
  root = undefined;
});

test("accepts checksummed BLOCKED placeholders but rejects an incomplete inventory", async () => {
  root = await mkdtemp(join(tmpdir(), "hosted-checksum-inventory-"));
  const entries = [];
  for (const name of REQUIRED_OUTPUTS) {
    const bytes = Buffer.from(`immutable ${name}\n`, "utf8");
    await writeFile(`${root}/${name}`, bytes);
    await chmod(`${root}/${name}`, 0o444);
    entries.push({ name, sha256: sha256(bytes) });
  }
  const sumsPath = `${root}/SHA256SUMS`;
  await writeFile(sumsPath, sha256Sums(entries));
  await chmod(sumsPath, 0o444);
  await expect(
    validateChecksumInventory({ artifactRoot: root }),
  ).resolves.toBeUndefined();
  const placeholder = Buffer.from(
    "required output gate.log was not produced\n",
    "utf8",
  );
  await chmod(`${root}/gate.log`, 0o644);
  await writeFile(`${root}/gate.log`, placeholder);
  await chmod(`${root}/gate.log`, 0o444);
  const placeholderEntries = entries.map((entry) =>
    entry.name === "gate.log"
      ? { name: entry.name, sha256: sha256(placeholder) }
      : entry,
  );
  await chmod(sumsPath, 0o644);
  await writeFile(sumsPath, sha256Sums(placeholderEntries));
  await chmod(sumsPath, 0o444);
  await expect(
    validateChecksumInventory({ artifactRoot: root }),
  ).resolves.toBeUndefined();
  await chmod(`${root}/gate.log`, 0o644);
  const restored = Buffer.from("immutable gate.log\n", "utf8");
  await writeFile(`${root}/gate.log`, restored);
  await chmod(`${root}/gate.log`, 0o444);
  await chmod(sumsPath, 0o644);
  await writeFile(sumsPath, sha256Sums(entries.slice(1)));
  await chmod(sumsPath, 0o444);
  await expect(
    validateChecksumInventory({ artifactRoot: root }),
  ).rejects.toThrow("artifact_checksum_inventory_incomplete");
});

test("never writes PASS from successful step outcomes with incomplete evidence", async () => {
  root = await mkdtemp(join(tmpdir(), "hosted-incomplete-pass-"));
  const workflowStatus = Object.fromEntries(
    [
      "build",
      "checkout",
      "cleanupFirst",
      "cleanupSecond",
      "commit",
      "context",
      "gate",
      "initialization",
      "install",
      "node",
      "prepare",
      "residue",
      "teardown",
    ].map((name) => [name, "success"]),
  );
  await writeFile(
    `${root}/workflow-status.json`,
    `${JSON.stringify(workflowStatus)}\n`,
  );
  const context = {
    artifactRoot: root,
    commit: "a".repeat(40),
    runAttempt: "2",
    runId: `wf-production-gate-${"b".repeat(32)}`,
    runNumber: "123456",
  };
  await packageArtifacts(context);
  const verdict = JSON.parse(
    await readFile(`${root}/hosted-verdict.json`, "utf8"),
  );
  expect(verdict).toMatchObject({
    blockedPhase: "evidence-validation",
    commit: context.commit,
    overallVerdict: "BLOCKED",
    runAttempt: context.runAttempt,
    runId: context.runNumber,
  });
  expect(await readFile(`${root}/SHA256SUMS`, "utf8")).toContain(
    "  hosted-verdict.json\n",
  );
});
