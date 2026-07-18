import { Buffer } from "node:buffer";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { runJournaledCleanup } from "./host-cleanup.mjs";
import { sha256 } from "./contract.mjs";
import {
  applyHostEffect,
  createHostState,
  markHostCleaned,
  prepareHostEffect,
  readHostState,
} from "./host-state.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function fixture(dockerBaseline = []) {
  const root = await mkdtemp(join(tmpdir(), "host-state-journal-"));
  roots.push(root);
  const artifactRoot = `${root}/evidence`;
  const controlRoot = `${root}/control`;
  await mkdir(artifactRoot);
  const suffix = "a".repeat(32);
  const context = {
    artifactRoot,
    commit: "b".repeat(40),
    controlRoot,
    hostRoot: `/opt/workload-funnel-hosted-production-gate-${suffix}`,
    runId: `wf-production-gate-${suffix}`,
  };
  const state = await createHostState(
    context,
    "2026-07-18T00:00:00.000Z",
    {},
    dockerBaseline,
  );
  return { context, state };
}

test("persists the exact canonical Docker image baseline", async () => {
  const image = {
    id: `sha256:${"a".repeat(64)}`,
    repoDigests: [`runner/cache@sha256:${"b".repeat(64)}`],
    repoTags: ["runner/cache:stable"],
    size: 1024,
  };
  const { context, state } = await fixture([image]);
  expect(state.dockerBaseline).toEqual([image]);
  expect((await readHostState(context)).dockerBaseline).toEqual([image]);
});

test("persists prepare intent before an effect and cleans it idempotently", async () => {
  const { context, state } = await fixture();
  await prepareHostEffect(state, {
    id: "owned-resource",
    kind: "host-root",
    path: state.hostRoot,
  });
  const persisted = JSON.parse(
    await readFile(`${context.controlRoot}/host-state.json`, "utf8"),
  );
  expect(persisted.effects).toEqual([
    {
      id: "owned-resource",
      kind: "host-root",
      path: state.hostRoot,
      status: "prepared",
    },
  ]);

  const cleanup = vi.fn();
  await runJournaledCleanup(state, "owned-resource", cleanup);
  await runJournaledCleanup(state, "owned-resource", cleanup);
  expect(cleanup).toHaveBeenCalledOnce();
  expect(state.effects[0].status).toBe("cleaned");
  await markHostCleaned(state);
  expect((await readHostState(context)).phase).toBe("cleaned");
});

test("recovers the fsynced partial journal revision after an interrupted rename", async () => {
  const { context, state } = await fixture();
  await prepareHostEffect(state, {
    id: "loop-device",
    kind: "loop-device",
    backingFile: `${state.hostRoot}/quota.xfs`,
  });
  const primary = await readFile(state.statePath, "utf8");
  await applyHostEffect(state, "loop-device", { path: "/dev/loop7" });
  const interrupted = await readFile(state.statePath, "utf8");
  await writeFile(state.statePath, primary);
  await writeFile(`${state.statePath}.partial`, interrupted, {
    flag: "wx",
    mode: 0o600,
  });

  const recovered = await readHostState(context);
  expect(recovered.revision).toBe(state.revision);
  expect(recovered.effects[0]).toMatchObject({
    path: "/dev/loop7",
    status: "applied",
  });
  await expect(access(`${state.statePath}.partial`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("refuses conflicting effect identities", async () => {
  const { state } = await fixture();
  await prepareHostEffect(state, {
    id: "owned-path",
    kind: "host-root",
    path: state.hostRoot,
  });
  await expect(
    prepareHostEffect(state, {
      id: "owned-path",
      kind: "host-root",
      path: "/opt/foreign",
    }),
  ).rejects.toThrow("host_state_effect_conflict");
});

test("discards malformed uncommitted partials beside a valid primary", async () => {
  for (const partial of [
    "{malformed\n",
    "",
    JSON.stringify({ journalChecksum: "0".repeat(64) }),
  ]) {
    const { context, state } = await fixture();
    await prepareHostEffect(state, {
      id: "owned-path",
      kind: "host-root",
      path: state.hostRoot,
    });
    await writeFile(`${state.statePath}.partial`, partial, {
      flag: "wx",
      mode: 0o600,
    });
    await expect(readHostState(context)).resolves.toMatchObject({
      revision: state.revision,
    });
    await expect(access(`${state.statePath}.partial`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

test("fails closed when only a malformed partial remains", async () => {
  const { context, state } = await fixture();
  await rm(state.statePath);
  await writeFile(`${state.statePath}.partial`, "{truncated", {
    flag: "wx",
    mode: 0o600,
  });
  await expect(readHostState(context)).rejects.toThrow("host_state_malformed");
});

test("refuses same-revision journal divergence", async () => {
  const { context, state } = await fixture();
  await prepareHostEffect(state, {
    id: "owned-path",
    kind: "host-root",
    path: state.hostRoot,
  });
  await applyHostEffect(state, "owned-path");
  const divergent = JSON.parse(await readFile(state.statePath, "utf8"));
  divergent.bootstrapExecutables = { systemctl: "/foreign/systemctl" };
  const unsigned = { ...divergent };
  delete unsigned.journalChecksum;
  divergent.journalChecksum = sha256(
    Buffer.from(JSON.stringify(unsigned), "utf8"),
  );
  await writeFile(`${state.statePath}.partial`, JSON.stringify(divergent), {
    flag: "wx",
    mode: 0o600,
  });
  await expect(readHostState(context)).rejects.toThrow(
    "host_state_revision_conflict",
  );
});
