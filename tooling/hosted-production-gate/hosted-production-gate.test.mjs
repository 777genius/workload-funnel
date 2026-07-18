import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ARCHITECTURE_PLAN_SHA256 } from "./constants.mjs";

import {
  collectReviewedFiles,
  sha256Sums,
  sourceTreeDigest,
} from "./review-manifest.mjs";
import {
  hostedContext,
  validateHostAdmission,
  validateTrustedIdentity,
  verifySha256,
} from "./contract.mjs";
import {
  blockedHostedVerdict,
  validatePrepareEvidence,
  validateHostedVerdict,
  validateProductionEvidence,
  validateRecoveryDocuments,
} from "./artifacts.mjs";
import { executeCleanupSteps, requireCertainCleanup } from "./host-cleanup.mjs";
import { removeFixtureTree } from "./fixture-cleanup.mjs";
import {
  classifyForeignProcesses,
  dockerImageInventory,
  observePidHeadroom,
  processInventory,
} from "./host-observation.mjs";
import { rejectedPrepareEvidence, settleHostAdmission } from "./host-setup.mjs";
import {
  installRuntimeCustody,
  verifyRuntimeCustody,
} from "./runtime-custody.mjs";
import {
  admittedObservation,
  certainRecovery,
  environment,
  exactPrepareFixture,
  identity,
  passingProductionEvidence,
} from "./hosted-production-gate.fixtures.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeFixtureTree(root)));
});

describe("hosted gate fail-closed contracts", () => {
  test("binds hosted review to the canonical architecture plan digest", async () => {
    const plan = await readFile(
      fileURLToPath(
        new URL(
          "../../docs/workload-funnel-architecture-plan.md",
          import.meta.url,
        ),
      ),
    );
    expect(createHash("sha256").update(plan).digest("hex")).toBe(
      ARCHITECTURE_PLAN_SHA256,
    );
  });

  test("preserves a sanitized rejected host observation", () => {
    const context = { runId: `wf-production-gate-${"a".repeat(32)}` };
    const observation = admittedObservation();
    const preparedAt = "2026-07-18T00:00:00.000Z";
    expect(
      rejectedPrepareEvidence(
        context,
        preparedAt,
        new Error("foreign_workload_service_state"),
        observation,
      ),
    ).toEqual({
      observation,
      prepared: false,
      preparedAt,
      reason: "foreign_workload_service_state",
      runId: context.runId,
      schemaVersion: "workload-funnel.hosted-production-gate.v1",
    });
    expect(
      rejectedPrepareEvidence(
        context,
        preparedAt,
        new Error("bootstrap_tool_inventory_incomplete"),
      ).observation,
    ).toBeNull();
  });

  test("settles only transient headroom and requires consecutive healthy samples", async () => {
    const busy = admittedObservation();
    busy.resources.cpuPsiSome = 0.2;
    const healthy = [
      admittedObservation(),
      admittedObservation(),
      admittedObservation(),
    ];
    const observations = [busy, ...healthy];
    const pause = vi.fn().mockResolvedValue(undefined);
    const recordObservation = vi.fn();
    await expect(
      settleHostAdmission(
        {},
        {
          maxObservations: 4,
          observe: async () => observations.shift(),
          pause,
          recordObservation,
          requiredStableObservations: 3,
          retryDelayMs: 1,
        },
      ),
    ).resolves.toEqual({
      observation: healthy[2],
      samples: [
        expect.objectContaining({ admitted: false, attempt: 1 }),
        expect.objectContaining({ admitted: true, attempt: 2 }),
        expect.objectContaining({ admitted: true, attempt: 3 }),
        expect.objectContaining({ admitted: true, attempt: 4 }),
      ],
    });
    expect(pause).toHaveBeenCalledTimes(3);
    expect(recordObservation).toHaveBeenCalledTimes(4);

    const foreign = admittedObservation();
    foreign.systemd.foreignUnits.push("foreign.service");
    const foreignPause = vi.fn();
    await expect(
      settleHostAdmission(
        {},
        {
          maxObservations: 4,
          observe: async () => foreign,
          pause: foreignPause,
          requiredStableObservations: 3,
          retryDelayMs: 1,
        },
      ),
    ).rejects.toThrow("foreign_workload_service_state");
    expect(foreignPause).not.toHaveBeenCalled();
  });

  test("derives only fixed owned paths from strict GitHub metadata", () => {
    const first = hostedContext(environment());
    const second = hostedContext(environment());
    expect(first).toEqual(second);
    expect(first.runId).toMatch(/^wf-production-gate-[a-f0-9]{32}$/u);
    expect(first.sandboxRoot).toBe(
      `/var/data/workload-funnel/sandboxes/${first.runId}`,
    );
    expect(first.controlRoot).toBe(
      `/var/lib/workload-funnel-hosted-production-gate-${first.runId.slice(-32)}`,
    );
    expect(first.hostRoot).toBe(
      `/var/lib/workload-funnel-hosted-runtime-${first.runId.slice(-32)}`,
    );
    expect(first.controlRoot.startsWith(first.artifactRoot)).toBe(false);
    expect(first.controlRoot.startsWith(first.hostRoot)).toBe(false);
    for (const hostile of [
      { GITHUB_WORKSPACE: "/home/runner/work/../foreign" },
      { GITHUB_WORKSPACE: "relative/project" },
      { RUNNER_TEMP: "/tmp/evidence/../foreign" },
      { GITHUB_SHA: "$(touch /tmp/hostile)" },
      { GITHUB_RUN_ID: "12;id" },
    ])
      expect(() => hostedContext(environment(hostile))).toThrow();
  });

  test("rejects symlink, owner, mode, path, digest, and ancestor drift", () => {
    const valid = identity("/usr/bin/tool");
    expect(
      validateTrustedIdentity(valid, {
        executable: true,
        expectedPath: "/usr/bin/tool",
        expectedSha256: "b".repeat(64),
      }),
    ).toBe(valid);
    for (const changed of [
      { canonicalPath: "/foreign/tool" },
      { gid: 1000 },
      { mode: 0o777 },
      { path: "/usr/bin/other" },
      { sha256: "c".repeat(64) },
      { symlink: true },
      {
        ancestors: [
          { gid: 0, kind: "directory", mode: 0o777, symlink: false, uid: 0 },
        ],
      },
    ])
      expect(() =>
        validateTrustedIdentity(
          { ...valid, ...changed },
          {
            executable: true,
            expectedPath: "/usr/bin/tool",
            expectedSha256: "b".repeat(64),
          },
        ),
      ).toThrow();
  });

  test("refuses incomplete tools and every class of foreign state", () => {
    expect(validateHostAdmission(admittedObservation()).admitted).toBe(true);
    const incomplete = admittedObservation();
    delete incomplete.tools.docker;
    expect(() => validateHostAdmission(incomplete)).toThrow(
      "bootstrap_tool_inventory_incomplete",
    );
    for (const mutate of [
      (value) => value.docker.containers.push("foreign"),
      (value) => value.docker.images.push("sha256:foreign"),
      (value) => value.docker.nonDefaultNetworks.push("foreign"),
      (value) => value.docker.volumes.push("foreign"),
      (value) => value.systemd.foreignUnits.push("foreign.service"),
      (value) => value.foreign.paths.push("/var/lib/workload-funnel"),
      (value) => value.foreign.processes.push("42"),
    ]) {
      const value = admittedObservation();
      mutate(value);
      expect(() => validateHostAdmission(value)).toThrow();
    }
  });

  test("admits an exact inert Docker image baseline and rejects pinned collisions", () => {
    const image = {
      id: `sha256:${"a".repeat(64)}`,
      repoDigests: [`runner/cache@sha256:${"b".repeat(64)}`],
      repoTags: ["runner/cache:stable"],
      size: 1024,
    };
    const observation = admittedObservation();
    observation.docker.images = [image];
    expect(validateHostAdmission(observation).admitted).toBe(true);
    observation.docker.pinnedReferenceCollisions = [image.id];
    expect(() => validateHostAdmission(observation)).toThrow(
      "foreign_image_state",
    );
  });

  test("refuses insufficient headroom and a wrong HyperQueue digest", () => {
    const observation = admittedObservation();
    observation.resources.diskAvailableBytes -= 1;
    expect(() => validateHostAdmission(observation)).toThrow(
      "host_headroom_insufficient",
    );
    const bytes = Buffer.from("official archive fixture", "utf8");
    expect(() => verifySha256(bytes, "0".repeat(64))).toThrow(
      "download_digest_mismatch",
    );
  });

  test("allows only exact documented runner service process tuples", () => {
    const processes = [
      {
        comm: "systemd",
        executable: "/usr/lib/systemd/systemd",
        pid: 1,
        ppid: 0,
        uid: 0,
        unit: null,
      },
      {
        comm: "kthreadd",
        executable: null,
        pid: 2,
        ppid: 0,
        uid: 0,
        unit: null,
      },
      {
        comm: "Runner.Worker",
        executable: "/opt/actions-runner/bin/Runner.Worker",
        pid: 100,
        ppid: 1,
        uid: 1001,
        unit: "runner-provisioner.service",
      },
      {
        comm: "dockerd",
        executable: "/usr/bin/dockerd",
        pid: 200,
        ppid: 1,
        uid: 0,
        unit: "docker.service",
      },
    ];
    expect(
      classifyForeignProcesses(processes, {
        currentPid: 100,
        runnerUid: 1001,
      }),
    ).toEqual([]);
    for (const foreign of [
      {
        comm: "bash",
        executable: "/usr/bin/bash",
        pid: 201,
        ppid: 1,
        uid: 1001,
        unit: "docker.service",
      },
      {
        comm: "foreign",
        executable: "/opt/foreign/workload",
        pid: 202,
        ppid: 1,
        uid: 1001,
        unit: null,
      },
    ])
      expect(
        classifyForeignProcesses([...processes, foreign], {
          currentPid: 100,
          runnerUid: 1001,
        }),
      ).toContainEqual(foreign);

    const image20260714240Processes = [
      {
        comm: "systemd-udevd",
        executable: "/usr/bin/udevadm",
        pid: 226,
        ppid: 1,
        uid: 0,
        unit: "systemd-udevd.service",
      },
      {
        comm: "hv_kvp_daemon",
        executable: "/usr/lib/linux-azure-6.17-tools-6.17.0-1020/hv_kvp_daemon",
        pid: 385,
        ppid: 1,
        uid: 0,
        unit: "hv-kvp-daemon.service",
      },
      {
        comm: "haveged",
        executable: "/usr/sbin/haveged",
        pid: 580,
        ppid: 1,
        uid: 0,
        unit: "haveged.service",
      },
      {
        comm: "php-fpm8.3",
        executable: "/usr/sbin/php-fpm8.3",
        pid: 964,
        ppid: 1,
        uid: 0,
        unit: "php8.3-fpm.service",
      },
      {
        comm: "python3",
        executable: "/usr/bin/python3.12",
        pid: 991,
        ppid: 1,
        uid: 0,
        unit: "walinuxagent.service",
      },
      {
        comm: "chronyd",
        executable: "/usr/sbin/chronyd",
        pid: 1116,
        ppid: 1,
        uid: 109,
        unit: "chrony.service",
      },
      {
        comm: "chronyd",
        executable: "/usr/sbin/chronyd",
        pid: 1118,
        ppid: 1116,
        uid: 109,
        unit: "chrony.service",
      },
      {
        comm: "rsyslogd",
        executable: "/usr/sbin/rsyslogd",
        pid: 1145,
        ppid: 1,
        uid: 102,
        unit: "rsyslog.service",
      },
      {
        comm: "(sd-pam)",
        executable: "/usr/lib/systemd/systemd-executor",
        pid: 1156,
        ppid: 1113,
        uid: 1001,
        unit: "user@1001.service",
      },
      {
        comm: "php-fpm8.3",
        executable: "/usr/sbin/php-fpm8.3",
        pid: 1281,
        ppid: 964,
        uid: 33,
        unit: "php8.3-fpm.service",
      },
      {
        comm: "php-fpm8.3",
        executable: "/usr/sbin/php-fpm8.3",
        pid: 1284,
        ppid: 964,
        uid: 33,
        unit: "php8.3-fpm.service",
      },
      {
        comm: "python3",
        executable: "/usr/bin/python3.12",
        pid: 1393,
        ppid: 991,
        uid: 0,
        unit: "walinuxagent.service",
      },
      {
        comm: "sudo",
        executable: "/usr/bin/sudo",
        pid: 2092,
        ppid: 2079,
        uid: 0,
        unit: "hosted-compute-agent.service",
      },
      {
        comm: "provjobd9593403",
        executable: null,
        pid: 2094,
        ppid: 2092,
        uid: 0,
        unit: "hosted-compute-agent.service",
      },
    ];
    expect(
      classifyForeignProcesses([...processes, ...image20260714240Processes], {
        currentPid: 100,
        runnerUid: 1001,
      }),
    ).toEqual([]);
    for (const [index, drift] of [
      [1, { executable: "/usr/lib/linux-azure-tools/hv_kvp_daemon" }],
      [7, { uid: 0 }],
      [9, { uid: 1001 }],
      [13, { comm: "provjobdabcdefg" }],
    ]) {
      const changed = {
        ...image20260714240Processes[index],
        ...drift,
      };
      const mutated = image20260714240Processes.with(index, changed);
      expect(
        classifyForeignProcesses([...processes, ...mutated], {
          currentPid: 100,
          runnerUid: 1001,
        }),
      ).toContainEqual(changed);
    }
    expect(
      classifyForeignProcesses(
        [
          ...processes,
          ...image20260714240Processes,
          {
            ...image20260714240Processes[10],
            pid: 1285,
          },
        ],
        { currentPid: 100, runnerUid: 1001 },
      ),
    ).not.toEqual([]);
  });

  test("ignores only an ENOENT process-exit race and refuses EACCES", async () => {
    const list = async () => [{ isDirectory: () => true, name: "42" }];
    const read = async (path) => {
      if (path.endsWith("/cgroup")) return "0::/foreign\n";
      if (path.endsWith("/comm")) return "foreign\n";
      return "PPid:\t1\nUid:\t1001\t1001\t1001\t1001\n";
    };
    await expect(
      processInventory({
        list,
        read,
        resolveExecutable: async () => {
          const error = new Error("denied");
          error.code = "EACCES";
          throw error;
        },
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      processInventory({
        list,
        read: async () => {
          const error = new Error("exited");
          error.code = "ENOENT";
          throw error;
        },
      }),
    ).resolves.toEqual([]);
  });

  test("uses the tightest current cgroup ancestor PID limit", async () => {
    const files = new Map([
      ["/proc/self/cgroup", "0::/actions_job/runner\n"],
      ["/proc/sys/kernel/pid_max", "4194304\n"],
      ["/proc/loadavg", "0.00 0.01 0.02 1/200 42\n"],
      ["/sys/fs/cgroup/actions_job/runner/pids.current", "100\n"],
      ["/sys/fs/cgroup/actions_job/runner/pids.max", "1000\n"],
      ["/sys/fs/cgroup/actions_job/pids.current", "150\n"],
      ["/sys/fs/cgroup/actions_job/pids.max", "500\n"],
      ["/sys/fs/cgroup/pids.current", "250\n"],
    ]);
    await expect(
      observePidHeadroom({
        read: async (path) => {
          if (files.has(path)) return files.get(path);
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        },
        resolve: async (path) => path,
      }),
    ).resolves.toBe(350);
  });

  test("captures a canonical exact Docker image baseline", async () => {
    const first = `sha256:${"a".repeat(64)}`;
    const second = `sha256:${"b".repeat(64)}`;
    const run = vi.fn(async (_executable, arguments_) => {
      if (arguments_[1] === "ls")
        return {
          code: 0,
          stderr: "",
          stdout: `${second}\n${first}\n${second}\n`,
        };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify([
          {
            Id: second,
            RepoDigests: [],
            RepoTags: ["runner/cache:second"],
            Size: 20,
          },
          {
            Id: first,
            RepoDigests: [`runner/cache@sha256:${"c".repeat(64)}`],
            RepoTags: null,
            Size: 10,
          },
        ]),
      };
    });
    await expect(dockerImageInventory({ run })).resolves.toEqual([
      {
        id: first,
        repoDigests: [`runner/cache@sha256:${"c".repeat(64)}`],
        repoTags: [],
        size: 10,
      },
      {
        id: second,
        repoDigests: [],
        repoTags: ["runner/cache:second"],
        size: 20,
      },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("uses kernel task headroom when the cgroup root has no PID files", async () => {
    const files = new Map([
      ["/proc/self/cgroup", "0::/\n"],
      ["/proc/sys/kernel/pid_max", "5000\n"],
      ["/proc/loadavg", "0.00 0.01 0.02 1/321 42\n"],
    ]);
    await expect(
      observePidHeadroom({
        read: async (path) => {
          if (files.has(path)) return files.get(path);
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        },
        resolve: async (path) => path,
      }),
    ).resolves.toBe(4679);
  });

  test("refuses escaped or incomplete cgroup PID scopes", async () => {
    const base = new Map([
      ["/proc/sys/kernel/pid_max", "5000\n"],
      ["/proc/loadavg", "0.00 0.01 0.02 1/321 42\n"],
    ]);
    const observe = (entries) =>
      observePidHeadroom({
        read: async (path) => {
          const value = entries.get(path);
          if (value !== undefined) return value;
          const error = new Error("missing");
          error.code = "ENOENT";
          throw error;
        },
        resolve: async (path) => path,
      });
    await expect(
      observe(
        new Map([
          ...base,
          ["/proc/self/cgroup", "0::/actions_job/../foreign\n"],
        ]),
      ),
    ).rejects.toThrow("host_cgroup_membership_malformed");
    await expect(
      observe(
        new Map([
          ...base,
          ["/proc/self/cgroup", "0::/actions_job/runner\n"],
          ["/sys/fs/cgroup/actions_job/runner/pids.current", "10\n"],
        ]),
      ),
    ).rejects.toThrow("host_cgroup_pid_scope_malformed");
  });
});

describe("generic review and cleanup evidence", () => {
  test("inventories every regular file generically and rejects a reviewed symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-production-review-"));
    roots.push(root);
    await mkdir(`${root}/nested`);
    await mkdir(`${root}/node_modules`);
    await writeFile(`${root}/root.txt`, "root\n");
    await writeFile(`${root}/nested/child.txt`, "child\n");
    await symlink("/outside", `${root}/node_modules/excluded-link`);
    const identity = await lstat(root);
    const inventory = await collectReviewedFiles(root, {
      expectedGid: identity.gid,
      expectedUid: identity.uid,
    });
    expect(inventory.map((item) => item.path)).toEqual([
      `${root}/nested/child.txt`,
      `${root}/root.txt`,
    ]);
    expect(sourceTreeDigest(inventory)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    await symlink(`${root}/root.txt`, `${root}/reviewed-link`);
    await expect(
      collectReviewedFiles(root, {
        expectedGid: identity.gid,
        expectedUid: identity.uid,
      }),
    ).rejects.toThrow("review_tree_symlink_refused");
  });

  test("copies every runtime dependency target into reviewed custody", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-runtime-custody-"));
    roots.push(root);
    const workspace = `${root}/workspace`;
    const reviewRoot = `${root}/review`;
    const storageBlob = `${root}/store/storage-blob`;
    const coreClient = `${root}/store/core-client`;
    await mkdir(`${workspace}/node_modules/@azure`, { recursive: true });
    await mkdir(`${workspace}/packages/internal`, { recursive: true });
    const internalManifest = JSON.stringify({
      name: "@workload-funnel/internal",
      version: "0.1.0",
    });
    await writeFile(
      `${workspace}/packages/internal/package.json`,
      internalManifest,
    );
    await writeFile(
      `${workspace}/packages/internal/index.js`,
      "export const internal = true;\n",
    );
    const prepareReview = async (path) => {
      await mkdir(`${path}/packages/internal`, { recursive: true });
      await writeFile(
        `${path}/packages/internal/package.json`,
        internalManifest,
      );
      await writeFile(
        `${path}/packages/internal/index.js`,
        "export const internal = true;\n",
      );
    };
    await prepareReview(reviewRoot);
    await mkdir(`${storageBlob}/node_modules/@azure`, { recursive: true });
    await mkdir(coreClient, { recursive: true });
    await writeFile(
      `${storageBlob}/package.json`,
      JSON.stringify({
        dependencies: { "@azure/core-client": "1.0.0" },
        name: "@azure/storage-blob",
        version: "12.33.0",
      }),
    );
    await writeFile(`${storageBlob}/index.js`, "export const blob = true;\n");
    await writeFile(
      `${coreClient}/package.json`,
      JSON.stringify({ name: "@azure/core-client", version: "1.0.0" }),
    );
    await writeFile(`${coreClient}/index.js`, "export const core = true;\n");
    await symlink(
      storageBlob,
      `${workspace}/node_modules/@azure/storage-blob`,
      "dir",
    );
    await symlink(
      coreClient,
      `${storageBlob}/node_modules/@azure/core-client`,
      "dir",
    );
    const custody = await installRuntimeCustody({
      packageNames: ["@azure/storage-blob", "@workload-funnel/internal"],
      reviewRoot,
      workspace,
    });
    const secondReviewRoot = `${root}/review-second`;
    await prepareReview(secondReviewRoot);
    const secondCustody = await installRuntimeCustody({
      packageNames: ["@azure/storage-blob", "@workload-funnel/internal"],
      reviewRoot: secondReviewRoot,
      workspace,
    });
    expect(secondCustody.bundle.sha256).toBe(custody.bundle.sha256);
    expect(custody.packages.map((item) => item.name).sort()).toEqual([
      "@azure/core-client",
      "@azure/storage-blob",
      "@workload-funnel/internal",
    ]);
    const storageTarget = custody.packages.find(
      (item) => item.name === "@azure/storage-blob",
    ).target;
    expect(
      await realpath(`${reviewRoot}/node_modules/@azure/storage-blob`),
    ).toBe(storageTarget);
    const inventoryIdentity = await lstat(reviewRoot);
    const inventory = await collectReviewedFiles(reviewRoot, {
      expectedGid: inventoryIdentity.gid,
      expectedUid: inventoryIdentity.uid,
    });
    expect(inventory).toContainEqual({
      path: custody.bundle.path,
      sha256: custody.bundle.sha256,
    });
    expect(sourceTreeDigest(inventory)).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const seal = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory() && !entry.isSymbolicLink()) await seal(path);
        if (!entry.isSymbolicLink())
          await chmod(path, entry.isDirectory() ? 0o555 : 0o444);
      }
      await chmod(directory, 0o555);
    };
    await seal(reviewRoot);
    await seal(secondReviewRoot);
    const reviewIdentity = await lstat(reviewRoot);
    await expect(
      verifyRuntimeCustody(
        {
          reviewRoot,
          runtimeIntegrity: custody.integrity,
        },
        { expectedGid: reviewIdentity.gid, expectedUid: reviewIdentity.uid },
      ),
    ).resolves.toMatchObject({ fileCount: 6, linkCount: 3 });
    const internalTarget = `${reviewRoot}/packages/internal/index.js`;
    await chmod(internalTarget, 0o644);
    await writeFile(internalTarget, "export const internalDrift = true;\n");
    await chmod(internalTarget, 0o444);
    await expect(
      verifyRuntimeCustody(
        { reviewRoot, runtimeIntegrity: custody.integrity },
        { expectedGid: reviewIdentity.gid, expectedUid: reviewIdentity.uid },
      ),
    ).rejects.toThrow("runtime_custody_file_drift");
    await chmod(internalTarget, 0o644);
    await writeFile(internalTarget, "export const internal = true;\n");
    await chmod(internalTarget, 0o444);
    await chmod(`${storageTarget}/index.js`, 0o644);
    await writeFile(
      `${storageTarget}/index.js`,
      "export const drift = true;\n",
    );
    await chmod(`${storageTarget}/index.js`, 0o444);
    await expect(
      verifyRuntimeCustody(
        { reviewRoot, runtimeIntegrity: custody.integrity },
        { expectedGid: reviewIdentity.gid, expectedUid: reviewIdentity.uid },
      ),
    ).rejects.toThrow("runtime_custody_file_drift");
    const secondIdentity = await lstat(secondReviewRoot);
    const link = `${secondReviewRoot}/node_modules/@azure/storage-blob`;
    await chmod(dirname(link), 0o755);
    await rm(link);
    await symlink(storageBlob, link, "dir");
    await chmod(dirname(link), 0o555);
    await expect(
      verifyRuntimeCustody(
        {
          reviewRoot: secondReviewRoot,
          runtimeIntegrity: secondCustody.integrity,
        },
        { expectedGid: secondIdentity.gid, expectedUid: secondIdentity.uid },
      ),
    ).rejects.toThrow("runtime_custody_link_drift");
  });

  test("does not hide cleanup failure with later destructive work", async () => {
    const unsafe = vi.fn();
    const independent = vi.fn();
    const cleanup = await executeCleanupSteps([
      {
        id: "failed-owned-resource",
        run: () => Promise.reject(new Error("cleanup_failure")),
      },
      {
        id: "unsafe-recursive-delete",
        requiresPriorSuccess: true,
        run: unsafe,
      },
      { id: "independent-evidence", run: independent },
    ]);
    expect(cleanup.certain).toBe(false);
    expect(unsafe).not.toHaveBeenCalled();
    expect(independent).toHaveBeenCalledOnce();
    expect(cleanup.results[1]).toMatchObject({
      ok: false,
      reason: "prior_cleanup_failed",
      skipped: true,
    });
    expect(() => requireCertainCleanup(cleanup)).toThrow(
      "host_cleanup_uncertain",
    );
    expect(requireCertainCleanup({ certain: true })).toEqual({ certain: true });
  });

  test("writes deterministic checksum lines", () => {
    expect(
      sha256Sums([
        { name: "z.log", sha256: "f".repeat(64) },
        { name: "a.json", sha256: "0".repeat(64) },
      ]),
    ).toBe(`${"0".repeat(64)}  a.json\n${"f".repeat(64)}  z.log\n`);
  });
});

describe("strict immutable final outcome", () => {
  test("records exact fail-closed hosted verdicts for early and sudo failures", () => {
    const context = hostedContext(environment());
    const successful = {
      build: "success",
      checkout: "success",
      cleanupFirst: "success",
      cleanupSecond: "success",
      commit: "success",
      context: "success",
      gate: "success",
      initialization: "success",
      install: "success",
      node: "success",
      prepare: "success",
      residue: "success",
      teardown: "success",
    };
    for (const [field, blockedPhase] of [
      ["checkout", "checkout"],
      ["node", "node-setup"],
      ["install", "dependency-install"],
      ["build", "build"],
      ["prepare", "host-prepare"],
    ]) {
      const status = { ...successful, [field]: "failure" };
      const verdict = blockedHostedVerdict(
        context,
        status,
        new Error("ignored_later_failure"),
      );
      expect(validateHostedVerdict(verdict, context)).toBe(verdict);
      expect(verdict).toMatchObject({
        blockedPhase,
        commit: context.commit,
        overallVerdict: "BLOCKED",
        runAttempt: context.runAttempt,
        runId: context.runNumber,
      });
    }
    const drifted = blockedHostedVerdict(
      context,
      { ...successful, checkout: "failure" },
      new Error("ignored"),
    );
    expect(() =>
      validateHostedVerdict({ ...drifted, commit: "0".repeat(40) }, context),
    ).toThrow("hosted_verdict_invalid");
  });

  test("requires the exact PASS evidence schema and every real component", () => {
    const context = hostedContext(environment());
    const evidence = passingProductionEvidence(context.runId);
    expect(validateProductionEvidence(evidence, context)).toBe(evidence);
    for (const mutate of [
      (value) => {
        value.schemaVersion = "workload-funnel.production-readiness-gate.v2";
        value.runId = `${context.runId}0`;
      },
      (value) => {
        value.overallVerdict = "BLOCKED";
      },
      (value) => {
        value.productionStartsEnabled = true;
      },
      (value) => {
        value.privilegedStartsEnabled = true;
      },
      (value) => {
        value.syntheticEvidenceAcceptedForRealFields = true;
      },
      (value) => {
        value.components[4].status = "BLOCKED";
      },
      (value) => {
        value.components[7].evidence[0].source = "synthetic";
      },
      (value) => {
        value.evidenceDigest = `sha256:${"0".repeat(64)}`;
      },
    ]) {
      const hostile = globalThis.structuredClone(evidence);
      mutate(hostile);
      expect(() => validateProductionEvidence(hostile, context)).toThrow();
    }
  });

  test("requires both cleanup recoveries certain on one exact run/host/review tuple", () => {
    const context = hostedContext(environment());
    const evidence = passingProductionEvidence(context.runId);
    const recoveries = [certainRecovery(evidence), certainRecovery(evidence)];
    expect(validateRecoveryDocuments(recoveries, evidence, context)).toBe(
      recoveries,
    );
    const uncertain = globalThis.structuredClone(recoveries);
    uncertain[0].cleanup.certain = false;
    expect(() =>
      validateRecoveryDocuments(uncertain, evidence, context),
    ).toThrow("cleanup_recovery_result_invalid");
    const tupleDrift = globalThis.structuredClone(recoveries);
    tupleDrift[1].review.reviewId = "github:different-review";
    expect(() =>
      validateRecoveryDocuments(tupleDrift, evidence, context),
    ).toThrow("cleanup_recovery_tuple_invalid");
    const pending = globalThis.structuredClone(recoveries);
    pending[1].cleanup.pending.push({ state: "uncertain" });
    expect(() => validateRecoveryDocuments(pending, evidence, context)).toThrow(
      "cleanup_recovery_result_invalid",
    );
  });

  test("binds exact AWS, PostgreSQL, private roots, and runtime custody evidence", () => {
    const context = hostedContext(environment());
    const { manifest, prepare } = exactPrepareFixture(context);
    expect(validatePrepareEvidence(prepare, manifest, context)).toBe(prepare);
    for (const mutate of [
      (value) => {
        value.downloads.awsCli.archiveSha256 = "0".repeat(64);
      },
      (value) => {
        value.downloads.awsCli.version = "2.35.24";
      },
      (value) => {
        value.downloads.awsCli.runnerPreinstallAccepted = true;
      },
      (value) => {
        value.downloads.postgresClient.packageVersion = "18.4-2.mutable";
      },
      (value) => {
        value.downloads.postgresClient.aptIsolation.sourceListPath =
          "/etc/apt/sources.list.d/postgresql.list";
      },
      (value) => {
        value.hostBootstrap.privateRootModes.allocations = 0o755;
      },
      (value) => {
        value.runtimeCustody = value.runtimeCustody.filter(
          (item) => item.name !== "@azure/storage-blob",
        );
      },
    ]) {
      const hostile = globalThis.structuredClone(prepare);
      mutate(hostile);
      expect(() =>
        validatePrepareEvidence(hostile, manifest, context),
      ).toThrow();
    }
    const missingRuntimeBytes = globalThis.structuredClone(manifest);
    missingRuntimeBytes.reviewedFiles =
      missingRuntimeBytes.reviewedFiles.filter(
        (item) => item.path !== prepare.runtimeBundle.path,
      );
    missingRuntimeBytes.sourceTreeDigest = sourceTreeDigest(
      missingRuntimeBytes.reviewedFiles,
    );
    expect(() =>
      validatePrepareEvidence(prepare, missingRuntimeBytes, context),
    ).toThrow("runtime_dependency_bundle_invalid");
    const missingRuntimeIntegrity = globalThis.structuredClone(manifest);
    missingRuntimeIntegrity.reviewedFiles =
      missingRuntimeIntegrity.reviewedFiles.filter(
        (item) => item.path !== prepare.runtimeIntegrity.path,
      );
    missingRuntimeIntegrity.sourceTreeDigest = sourceTreeDigest(
      missingRuntimeIntegrity.reviewedFiles,
    );
    expect(() =>
      validatePrepareEvidence(prepare, missingRuntimeIntegrity, context),
    ).toThrow("runtime_custody_integrity_invalid");
  });
});

describe("manual workflow contract", () => {
  test("keeps the heavy job manual and preserves early fail-closed evidence", async () => {
    const workflowPath = fileURLToPath(
      new URL("../../.github/workflows/ci.yml", import.meta.url),
    );
    const standalonePath = fileURLToPath(
      new URL(
        "../../.github/workflows/hosted-production-gate.yml",
        import.meta.url,
      ),
    );
    const workflow = await readFile(workflowPath, "utf8");
    const documentation = await readFile(
      fileURLToPath(
        new URL(
          "../../docs/operations/github-hosted-production-gate.md",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect((await lstat(workflowPath)).isFile()).toBe(true);
    await expect(lstat(standalonePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(workflow).toContain(
      "workflow_dispatch:\n    inputs:\n      expected_sha:",
    );
    expect(workflow).toContain("expected_sha:\n        description:");
    const heavyJob = workflow.slice(
      workflow.indexOf("  production-readiness:"),
    );
    expect(heavyJob).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(heavyJob).toContain("ref: ${{ github.sha }}");
    expect(heavyJob).toContain("EXPECTED_SHA: ${{ inputs.expected_sha }}");
    expect(heavyJob).toContain('test "$EXPECTED_SHA" = "$GITHUB_SHA"');
    expect(heavyJob.indexOf("Initialize evidence directory")).toBeLessThan(
      heavyJob.indexOf("Install exact dependencies"),
    );
    expect(heavyJob).toContain("Seal fail-closed fallback evidence");
    expect(heavyJob).toContain("hosted-verdict.json");
    expect(heavyJob).toContain('"overallVerdict":"BLOCKED"');
    expect(heavyJob).toContain("PACKAGE_OUTCOME: ${{ steps.package.outcome }}");
    expect(heavyJob).toContain("required output %s was not produced\\n");
    expect(workflow).not.toMatch(/^ {2}schedule:/gmu);
    expect(workflow).toMatch(/^ {2}pull_request:/mu);
    expect(workflow).toMatch(/^ {2}push:/mu);
    expect(workflow).toContain(
      "verify:\n    if: github.event_name != 'workflow_dispatch'",
    );
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(heavyJob.match(/run\.mjs gate$/gmu)).toHaveLength(1);
    expect(heavyJob.match(/run\.mjs cleanup-1$/gmu)).toHaveLength(1);
    expect(heavyJob.match(/run\.mjs cleanup-2$/gmu)).toHaveLength(1);
    for (const name of [
      "Recover cleanup first pass",
      "Recover cleanup second pass",
      "Verify zero owned residue",
      "Upload immutable production-gate evidence",
    ]) {
      const start = heavyJob.indexOf(`- name: ${name}`);
      const end = heavyJob.indexOf("\n      - name:", start + 1);
      expect(heavyJob.slice(start, end < 0 ? undefined : end)).toContain(
        "if: always()",
      );
    }
    expect(workflow).toContain(
      "uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    );
    expect(workflow).toContain(
      "path: ${{ runner.temp }}/wf-production-gate-${{ github.run_id }}-${{ github.run_attempt }}-evidence",
    );
    expect(workflow).not.toMatch(
      /path:\s*\$\{\{ runner\.temp \}\}\/wf-production-gate-[^\n]*\*[^\n]*-evidence/u,
    );
    expect(workflow).toContain("overwrite: false");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toMatch(/productionStartsEnabled\s*:\s*true/u);
    expect(documentation).toContain(
      "after `ci.yml` is present on the\nrepository's default branch",
    );
    for (const reference of workflow.matchAll(
      /^\s*uses:\s*[^@\s]+@([^\s]+)/gmu,
    ))
      expect(reference[1]).toMatch(/^[a-f0-9]{40}$/u);
    let shellBlock = false;
    for (const line of workflow.split("\n")) {
      if (/^\s{6}- name:/u.test(line)) shellBlock = false;
      if (/^\s{8}run:\s*\|\s*$/u.test(line)) shellBlock = true;
      else if (shellBlock) expect(line).not.toContain("${{");
    }
  });
});
