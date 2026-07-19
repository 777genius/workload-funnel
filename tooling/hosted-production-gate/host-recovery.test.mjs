import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";

import { afterEach, expect, test, vi } from "vitest";

import {
  assertOwnedImageOutsideBaseline,
  CLEANUP_EFFECT_ORDER,
  cleanupHost,
  productionCleanupEvidenceRequired,
  runJournaledCleanup,
  validateOwnedImageInspection,
  validateOwnedMountInspection,
  validateSyntheticIdentityForCleanup,
} from "./host-cleanup.mjs";
import {
  cleanupTombstonePath,
  finalizeCleanedControlState,
  readCleanedEvidence,
} from "./cleanup-finalization.mjs";
import { removeFixtureTree } from "./fixture-cleanup.mjs";
import {
  finishGateChild,
  gateChildPlan,
  planGateChild,
  recoverGateChild,
  startGateChild,
} from "./gate-child-state.mjs";
import {
  classifyOwnedPackagePlan,
  exactAppliedPackageChanges,
  exactPackagePlan,
  parseAptSimulation,
} from "./host-tools.mjs";
import {
  createHostState,
  markHostCleaned,
  prepareHostEffect,
  readHostState,
  saveHostState,
} from "./host-state.mjs";
import { writeRecoverableJsonAtomically } from "./recoverable-json.mjs";
import { validateResidue } from "./residue.mjs";

const execFileAsync = promisify(execFile);

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureTree(root)));
});

const fixtureIdentityOptions = Object.freeze({
  expectedGid: process.getgid?.(),
  expectedUid: process.getuid?.(),
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "host-recovery-"));
  roots.push(root);
  const suffix = "a".repeat(32);
  const context = {
    artifactRoot: `${root}/evidence`,
    commit: "b".repeat(40),
    controlRoot: `${root}/control`,
    hostRoot: `/var/lib/workload-funnel-hosted-runtime-${suffix}`,
    runId: `wf-production-gate-${suffix}`,
  };
  await mkdir(context.artifactRoot);
  const state = await createHostState(context, "2026-07-18T00:00:00.000Z");
  state.executables = {
    node: "/opt/reviewed/node",
    systemctl: "/usr/bin/systemctl",
  };
  await saveHostState(state);
  return { context, state };
}

test("fsyncs every gate child planned, started, and finished transition", async () => {
  const { context, state } = await fixture();
  const planned = await planGateChild(state, "gate");
  expect((await readHostState(context)).gateInvocations[0]).toEqual(planned);
  const identity = {
    cgroup: `0::/system.slice/${planned.unit}`,
    executable: state.executables.node,
    pid: 4242,
    starttime: "991122",
  };
  await startGateChild(context, "gate", identity);
  expect((await readHostState(context)).gateInvocations[0]).toMatchObject({
    ...identity,
    status: "started",
  });
  const reloaded = await readHostState(context);
  await finishGateChild(reloaded, "gate", { exitCode: 1 });
  expect((await readHostState(context)).gateInvocations[0]).toMatchObject({
    exitCode: 1,
    outcome: "completed",
    status: "finished",
  });
});

test("recovers a collected unit that crashed before startGateChild as never spawned", async () => {
  const { context, state } = await fixture();
  const planned = await planGateChild(state, "gate");
  const observations = [
    {
      ActiveState: "failed",
      CollectMode: "inactive-or-failed",
      ControlGroup: "",
      Description: `workload-funnel-hosted-gate:${planned.marker}`,
      LoadState: "loaded",
      MainPID: "0",
    },
    {
      ActiveState: "failed",
      CollectMode: "inactive-or-failed",
      ControlGroup: "",
      Description: `workload-funnel-hosted-gate:${planned.marker}`,
      LoadState: "loaded",
      MainPID: "0",
    },
    {
      ActiveState: "inactive",
      ControlGroup: "",
      LoadState: "not-found",
      MainPID: "0",
    },
  ];
  const command = vi
    .fn()
    .mockResolvedValue({ code: 0, stderr: "", stdout: "" });
  await recoverGateChild(state, "gate", {
    command,
    markers: async () => [],
    pause: async () => undefined,
    show: async () => observations.shift(),
  });
  expect(command).toHaveBeenCalledWith("/usr/bin/systemctl", [
    "reset-failed",
    planned.unit,
  ]);
  expect((await readHostState(context)).gateInvocations[0]).toMatchObject({
    exitCode: 0,
    outcome: "never-spawned",
    status: "finished",
  });
});

test("refuses active, ambiguous, or identity-drifted planned children", async () => {
  for (const scenario of [
    {
      matches: [],
      mainPid: "42",
      expected: "gate_child_started_identity_missing",
    },
    {
      activeState: "inactive",
      description: "foreign-unit",
      matches: [],
      mainPid: "0",
      expected: "gate_child_unit_identity_changed",
    },
    {
      matches: [
        { cgroup: "0::/unit", executable: "/node", pid: 42, starttime: "1" },
        { cgroup: "0::/unit", executable: "/node", pid: 43, starttime: "2" },
      ],
      mainPid: "42",
      expected: "gate_child_identity_ambiguous",
    },
    {
      matches: [
        { cgroup: "0::/wrong", executable: "/node", pid: 42, starttime: "1" },
      ],
      mainPid: "42",
      expected: "gate_child_identity_changed",
    },
  ]) {
    const { state } = await fixture();
    const planned = await planGateChild(state, "gate");
    await expect(
      recoverGateChild(state, "gate", {
        markers: async () => scenario.matches,
        show: async () => ({
          ActiveState: scenario.activeState ?? "active",
          CollectMode: "inactive-or-failed",
          ControlGroup: "/system.slice/exact.service",
          Description:
            scenario.description ??
            `workload-funnel-hosted-gate:${planned.marker}`,
          LoadState: "loaded",
          MainPID: scenario.mainPid,
        }),
      }),
    ).rejects.toThrow(scenario.expected);
  }
});

test("bypasses missing cleanup documents only when the gate never spawned", () => {
  const context = { runId: `wf-production-gate-${"a".repeat(32)}` };
  const planned = gateChildPlan(context, "gate");
  expect(productionCleanupEvidenceRequired({ gateInvocations: [] })).toBe(
    false,
  );
  expect(
    productionCleanupEvidenceRequired({
      gateInvocations: [
        {
          ...planned,
          exitCode: 0,
          outcome: "never-spawned",
          status: "finished",
        },
      ],
    }),
  ).toBe(false);
  for (const gate of [
    planned,
    {
      ...planned,
      cgroup: `0::/${planned.unit}`,
      executable: "/node",
      pid: 7,
      starttime: "1",
      status: "started",
    },
    {
      ...planned,
      exitCode: 255,
      outcome: "recovered-absent",
      status: "finished",
    },
  ])
    expect(productionCleanupEvidenceRequired({ gateInvocations: [gate] })).toBe(
      true,
    );
});

test("owns only the exact planned package closure across an install crash", () => {
  const simulated = parseAptSimulation(
    "Inst libpq5 [16.9-1] (18.4-1 PostgreSQL [amd64])\n" +
      "Inst postgresql-client-18 (18.4-1.pgdg24.04+1 PostgreSQL [amd64])\n",
  );
  const plan = exactPackagePlan(
    { "libpq5:amd64": "16.9-1", foreign: "1.0" },
    simulated,
  );
  expect(
    classifyOwnedPackagePlan(plan, {
      "libpq5:amd64": "18.4-1",
      foreign: "2.0",
      "postgresql-client-18": "18.4-1.pgdg24.04+1",
    }),
  ).toEqual({
    remove: ["postgresql-client-18"],
    restore: [{ name: "libpq5:amd64", version: "16.9-1" }],
  });
  expect(
    classifyOwnedPackagePlan(plan, {
      "libpq5:amd64": "16.9-1",
      foreign: "2.0",
    }),
  ).toEqual({ remove: [], restore: [] });
  expect(() =>
    classifyOwnedPackagePlan(plan, {
      "libpq5:amd64": "19.0-foreign",
      foreign: "2.0",
    }),
  ).toThrow("owned_package_identity_changed");
  expect(
    exactAppliedPackageChanges(
      { "libpq5:amd64": "16.9-1", foreign: "1.0" },
      plan,
      {
        "libpq5:amd64": "18.4-1",
        foreign: "1.0",
        "postgresql-client-18": "18.4-1.pgdg24.04+1",
      },
    ),
  ).toEqual({
    changed: [{ from: "16.9-1", name: "libpq5:amd64", to: "18.4-1" }],
    installed: [
      { name: "postgresql-client-18", version: "18.4-1.pgdg24.04+1" },
    ],
    removed: [],
  });
  expect(() =>
    exactAppliedPackageChanges(
      { "libpq5:amd64": "16.9-1", foreign: "1.0" },
      plan,
      {
        "libpq5:amd64": "18.4-1",
        foreign: "2.0",
        "postgresql-client-18": "18.4-1.pgdg24.04+1",
      },
    ),
  ).toThrow("bootstrap_package_change_untrusted");
  expect(() =>
    parseAptSimulation(
      "Remv foreign [1.0]\n" +
        "Inst postgresql-client-18 (18.4-1.pgdg24.04+1 PostgreSQL [amd64])\n",
    ),
  ).toThrow("package_plan_removal_refused");
});

test("accepts true mount absence but rejects containing-root and option drift", () => {
  const effect = {
    device: "/dev/loop7",
    path: "/var/lib/workload-funnel",
    status: "prepared",
  };
  expect(
    validateOwnedMountInspection(effect, { code: 1, stdout: "" }),
  ).toBeUndefined();
  for (const item of [
    { fstype: "ext4", options: "rw", source: "/dev/root", target: "/" },
    {
      fstype: "xfs",
      options: "rw,prjquota",
      source: "/dev/loop7",
      target: effect.path,
    },
  ])
    expect(() =>
      validateOwnedMountInspection(effect, {
        code: 0,
        stdout: JSON.stringify({ filesystems: [item] }),
      }),
    ).toThrow("owned_mount_identity_changed");
});

test("refuses recreated identity and image digest or multiplicity drift", () => {
  const identity = {
    name: "workload-funnel-synthetic",
    tuple:
      "workload-funnel-synthetic:x:899:899::/nonexistent:/usr/sbin/nologin",
  };
  expect(
    validateSyntheticIdentityForCleanup(identity, {
      code: 0,
      stdout: `${identity.tuple}\n`,
    }),
  ).toBe(true);
  expect(() =>
    validateSyntheticIdentityForCleanup(identity, {
      code: 0,
      stdout: "workload-funnel-synthetic:x:898:898:foreign:/tmp:/bin/sh\n",
    }),
  ).toThrow("synthetic_identity_changed");

  const digest = "c".repeat(64);
  const effect = {
    digest,
    imageId: `sha256:${"d".repeat(64)}`,
    reference: `example.invalid/image:fixed@sha256:${digest}`,
    repoDigest: `example.invalid/image@sha256:${digest}`,
    repoTags: [],
    status: "applied",
  };
  expect(
    validateOwnedImageInspection(effect, {
      code: 1,
      stderr: "Error response from daemon: No such image: exact\n",
      stdout: "[]\n",
    }),
  ).toBeUndefined();
  for (const RepoDigests of [
    [`example.invalid/image@sha256:${"e".repeat(64)}`],
    [effect.repoDigest, `foreign/image@sha256:${digest}`],
  ])
    expect(() =>
      validateOwnedImageInspection(effect, {
        code: 0,
        stdout: JSON.stringify([
          { Id: effect.imageId, RepoDigests, RepoTags: [] },
        ]),
      }),
    ).toThrow("owned_image_identity_changed");
  const inspected = {
    Id: effect.imageId,
    RepoDigests: [effect.repoDigest],
    RepoTags: [],
  };
  expect(() => assertOwnedImageOutsideBaseline(inspected, [])).not.toThrow();
  expect(() =>
    assertOwnedImageOutsideBaseline(inspected, [
      {
        id: effect.imageId,
        repoDigests: [],
        repoTags: ["runner/cache:stable"],
        size: 1024,
      },
    ]),
  ).toThrow("owned_image_baseline_collision");
});

test("recovers a crash at every cleanup step and a second pass touches no foreign state", async () => {
  for (const crashedId of CLEANUP_EFFECT_ORDER) {
    const { state } = await fixture();
    for (const id of CLEANUP_EFFECT_ORDER)
      await prepareHostEffect(state, { id, kind: "host-root" });
    const owned = new Map(CLEANUP_EFFECT_ORDER.map((id) => [id, true]));
    const foreign = { value: "untouched" };
    let injected = false;
    for (const id of CLEANUP_EFFECT_ORDER) {
      try {
        await runJournaledCleanup(state, id, async () => {
          owned.set(id, false);
          if (id === crashedId && !injected) {
            injected = true;
            throw new Error("crash_after_effect_before_mark");
          }
        });
      } catch (error) {
        expect(error.message).toBe("crash_after_effect_before_mark");
        break;
      }
    }
    for (const id of CLEANUP_EFFECT_ORDER)
      await runJournaledCleanup(state, id, async () => owned.set(id, false));
    expect([...owned.values()].every((value) => value === false)).toBe(true);
    expect(foreign.value).toBe("untouched");
    const cleanup = vi.fn();
    for (const id of CLEANUP_EFFECT_ORDER)
      await runJournaledCleanup(state, id, cleanup);
    expect(cleanup).not.toHaveBeenCalled();
  }
}, 15_000);

test("unmount-before-mark retries absence instead of the containing root filesystem", async () => {
  const { state } = await fixture();
  await prepareHostEffect(state, { id: "xfs-mount", kind: "xfs-mount" });
  let mounted = true;
  await expect(
    runJournaledCleanup(state, "xfs-mount", async () => {
      mounted = false;
      throw new Error("crash_after_unmount");
    }),
  ).rejects.toThrow("crash_after_unmount");
  await runJournaledCleanup(state, "xfs-mount", async () => {
    expect(mounted).toBe(false);
  });
  expect(state.effects[0].status).toBe("cleaned");
  expect(
    JSON.parse(await readFile(state.statePath, "utf8")).effects[0].status,
  ).toBe("cleaned");
});

test("replays final cleanup across state move, control rmdir, and tombstone unlink", async () => {
  const boundaries = [
    "move-before",
    "move-after",
    "rmdir-after",
    "unlink-after",
  ];
  for (const boundary of boundaries) {
    const { context, state } = await fixture();
    await markHostCleaned(state);
    let interrupted = false;
    const operations = {
      moveState: async (source, destination) => {
        if (boundary === "move-before" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted_move_before");
        }
        await rename(source, destination);
        if (boundary === "move-after" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted_move_after");
        }
      },
      removeControl: async (path) => {
        await rmdir(path);
        if (boundary === "rmdir-after" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted_rmdir_after");
        }
      },
      removeTombstone: async (path) => {
        await rm(path);
        if (boundary === "unlink-after" && !interrupted) {
          interrupted = true;
          throw new Error("interrupted_unlink_after");
        }
      },
    };
    await expect(
      finalizeCleanedControlState(state, {
        ...operations,
        ...fixtureIdentityOptions,
      }),
    ).rejects.toThrow(/^interrupted_/u);
    await finalizeCleanedControlState(state, fixtureIdentityOptions);
    await expect(access(context.controlRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(cleanupTombstonePath(context))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }
});

test("refuses a recreated control directory while a cleanup tombstone is durable", async () => {
  const { context, state } = await fixture();
  await markHostCleaned(state);
  await expect(
    finalizeCleanedControlState(state, {
      ...fixtureIdentityOptions,
      removeControl: async (path) => {
        await rmdir(path);
        throw new Error("interrupted_rmdir_after");
      },
    }),
  ).rejects.toThrow("interrupted_rmdir_after");
  await mkdir(context.controlRoot, { mode: 0o700 });
  await expect(
    finalizeCleanedControlState(state, fixtureIdentityOptions),
  ).rejects.toThrow("host_state_control_root_changed");
});

test("a fully completed teardown is a no-op only with exact cleaned evidence", async () => {
  const { context, state } = await fixture();
  await markHostCleaned(state);
  await writeFile(
    `${context.artifactRoot}/host-state-evidence.json`,
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o444 },
  );
  await writeFile(
    `${context.artifactRoot}/host-cleanup.json`,
    `${JSON.stringify({
      certain: true,
      failed: [],
      results: [{ id: "cleanup_journal_complete", ok: true }],
      runId: context.runId,
      schemaVersion: "workload-funnel.hosted-production-gate.v1",
    })}\n`,
    { mode: 0o444 },
  );
  await chmod(`${context.artifactRoot}/host-state-evidence.json`, 0o444);
  await chmod(`${context.artifactRoot}/host-cleanup.json`, 0o444);
  await finalizeCleanedControlState(state, fixtureIdentityOptions);
  const proveZeroResidue = vi.fn().mockResolvedValue({ zeroResidue: true });
  await expect(
    cleanupHost(context, {
      proveZeroResidue,
      readEvidence: (value) =>
        readCleanedEvidence(value, fixtureIdentityOptions),
    }),
  ).resolves.toMatchObject({ certain: true });
  expect(proveZeroResidue).toHaveBeenCalledOnce();
  await mkdir(context.controlRoot, { mode: 0o700 });
  await expect(cleanupHost(context, { proveZeroResidue })).rejects.toThrow(
    "host_state_missing",
  );
});

function residueEvidence(context) {
  return {
    checks: {
      containers: "",
      foreignProcesses: [],
      groupExists: false,
      imageBaseline: [],
      imageBaselineMatches: true,
      imageInventory: [],
      imageProbesCertain: true,
      images: [],
      loopAbsent: true,
      mountAbsent: true,
      networks: [],
      observedProcessCount: 1,
      ownedProcesses: [],
      packageProbesCertain: true,
      packages: [],
      paths: [],
      processProbeCertain: true,
      units: "",
      userExists: false,
      volumes: "",
    },
    runId: context.runId,
    schemaVersion: "workload-funnel.hosted-production-gate.v1",
    zeroResidue: true,
  };
}

function replayDependencies(residue) {
  return {
    finalizeState: (state) =>
      finalizeCleanedControlState(state, {
        expectedGid: process.getgid?.(),
        expectedUid: process.getuid?.(),
      }),
    proveRuntimeAbsent: async () => undefined,
    proveZeroResidue: async (context, options) => {
      await options.writeEvidence(
        `${context.artifactRoot}/residue.json`,
        residue,
        {
          acceptExisting: (candidate) => {
            validateResidue(candidate, context);
            return true;
          },
          mode: 0o444,
        },
      );
      return residue;
    },
    recoverChild: async () => undefined,
  };
}

test("a SIGKILL before, during, or after every pre-tombstone evidence write converges on the second teardown", async () => {
  for (const target of [
    "residue.json",
    "host-state-evidence.json",
    "host-cleanup.json",
  ]) {
    for (const boundary of ["before", "during", "after"]) {
      const { context } = await fixture();
      const residue = residueEvidence(context);
      const contextPath = `${context.artifactRoot}/crash-context.json`;
      const residueFixturePath = `${context.artifactRoot}/crash-residue.json`;
      await writeFile(contextPath, `${JSON.stringify(context)}\n`);
      await writeFile(residueFixturePath, `${JSON.stringify(residue)}\n`);
      await expect(
        execFileAsync(process.execPath, [
          new URL("./recoverable-evidence-crash-child.mjs", import.meta.url)
            .pathname,
          contextPath,
          residueFixturePath,
          target,
          boundary,
        ]),
      ).rejects.toMatchObject({ signal: "SIGKILL" });

      const priorValidEvidence = new Map();
      for (const name of [
        "residue.json",
        "host-state-evidence.json",
        "host-cleanup.json",
      ]) {
        try {
          const bytes = await readFile(`${context.artifactRoot}/${name}`);
          JSON.parse(bytes.toString("utf8"));
          priorValidEvidence.set(name, bytes);
        } catch (error) {
          if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
            throw error;
        }
      }

      await cleanupHost(context, replayDependencies(residue));
      for (const [name, bytes] of priorValidEvidence)
        expect(await readFile(`${context.artifactRoot}/${name}`)).toEqual(
          bytes,
        );
      for (const name of [
        "residue.json",
        "host-state-evidence.json",
        "host-cleanup.json",
      ]) {
        expect(
          JSON.parse(await readFile(`${context.artifactRoot}/${name}`, "utf8")),
        ).toBeTruthy();
        await expect(
          access(`${context.artifactRoot}/${name}.partial`),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
      await expect(access(context.controlRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(cleanupTombstonePath(context))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
    }
  }
}, 30_000);

test("recovers a truncated partial but fails closed on corrupt or ambiguous residue", async () => {
  const { context } = await fixture();
  const residue = residueEvidence(context);
  const path = `${context.artifactRoot}/residue.json`;
  const options = {
    acceptExisting: (candidate) => {
      validateResidue(candidate, context);
      return true;
    },
    mode: 0o444,
  };
  await writeFile(`${path}.partial`, '{"checks":', { mode: 0o444 });
  await writeRecoverableJsonAtomically(path, residue, options);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(residue);

  await chmod(path, 0o644);
  await writeFile(path, "{corrupt\n");
  await chmod(path, 0o444);
  await expect(
    writeRecoverableJsonAtomically(path, residue, options),
  ).rejects.toThrow("recoverable_json_primary_corrupt");
  expect(await readFile(path, "utf8")).toBe("{corrupt\n");

  await rm(path);
  await writeFile(
    `${path}.partial`,
    `${JSON.stringify({ ...residue, zeroResidue: false })}\n`,
    { mode: 0o444 },
  );
  await expect(
    writeRecoverableJsonAtomically(path, residue, options),
  ).rejects.toThrow("recoverable_json_partial_corrupt");
});
