import { lstat, readFile, rmdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  ALLOCATION_MOUNT,
  HOSTED_GATE_SCHEMA,
  SANDBOX_PARENT,
} from "./constants.mjs";
import { HostedGateRefusal, validateCleanupResults } from "./contract.mjs";
import {
  finalizeCleanedControlState,
  readCleanedEvidence,
  readCleanupTombstone,
} from "./cleanup-finalization.mjs";
import { recoverGateChild } from "./gate-child-state.mjs";
import {
  getHostEffect,
  markHostCleaned,
  markHostEffectCleaned,
  readHostState,
} from "./host-state.mjs";
import {
  installedPackageInventory,
  classifyOwnedPackagePlan,
} from "./host-tools.mjs";
import { processInventory } from "./host-observation.mjs";
import { runCommand } from "./process-runner.mjs";
import { inspectPathIdentity } from "./review-manifest.mjs";
import { writeRecoverableJsonAtomically } from "./recoverable-json.mjs";
import { verifyZeroResidue } from "./residue.mjs";

export const CLEANUP_EFFECT_ORDER = Object.freeze([
  "docker-image:azurite-fixture",
  "docker-image:object-client",
  "docker-image:object-fixture",
  "docker-image:postgres-fixture",
  "synthetic-user",
  "synthetic-group",
  "xfs-mount",
  "loop-device",
  "packages",
  "sandbox-parent",
  "allocation-mount-point",
  "loop-image",
  "project-quota-helper",
  "host-root",
]);

function code(error) {
  return error instanceof Error ? error.message : "hosted_gate_cleanup_failed";
}

async function required(executable, arguments_, failure, options) {
  const result = await runCommand(executable, arguments_, options);
  if (result.code !== 0) throw new HostedGateRefusal(failure);
  return result.stdout;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function executeCleanupSteps(steps) {
  const results = [];
  let previousFailed = false;
  for (const step of steps) {
    if (previousFailed && step.requiresPriorSuccess === true) {
      results.push({
        id: step.id,
        ok: false,
        reason: "prior_cleanup_failed",
        skipped: true,
      });
      continue;
    }
    try {
      await step.run();
      results.push({ id: step.id, ok: true });
    } catch (error) {
      previousFailed = true;
      results.push({ id: step.id, ok: false, reason: code(error) });
    }
  }
  return validateCleanupResults(results);
}

export function requireCertainCleanup(cleanup) {
  if (cleanup?.certain !== true)
    throw new HostedGateRefusal("host_cleanup_uncertain");
  return cleanup;
}

export async function runJournaledCleanup(state, id, cleanup) {
  const effect = getHostEffect(state, id);
  if (effect === undefined)
    throw new HostedGateRefusal("host_cleanup_effect_missing");
  if (effect.status === "cleaned") return Object.freeze({ alreadyClean: true });
  await cleanup(effect);
  await markHostEffectCleaned(state, id);
  return Object.freeze({ alreadyClean: false });
}

function effectStep(state, id, cleanup) {
  return {
    id,
    requiresPriorSuccess: true,
    run: () => runJournaledCleanup(state, id, cleanup),
  };
}

async function gateCleanupCertain(context) {
  try {
    const statuses = await Promise.all(
      ["cleanup-1-status.json", "cleanup-2-status.json"].map(async (name) =>
        JSON.parse(await readFile(`${context.artifactRoot}/${name}`, "utf8")),
      ),
    );
    const documents = await Promise.all(
      ["cleanup-1.json", "cleanup-2.json"].map(async (name) =>
        JSON.parse(await readFile(`${context.artifactRoot}/${name}`, "utf8")),
      ),
    );
    return statuses.every(
      (item, index) =>
        item.exitCode === 0 &&
        item.runId === context.runId &&
        item.operation === "recover-cleanup" &&
        item.invocation === `cleanup-${index + 1}` &&
        documents[index]?.runId === context.runId &&
        documents[index]?.cleanup?.certain === true &&
        Array.isArray(documents[index].cleanup.pending) &&
        documents[index].cleanup.pending.length === 0,
    );
  } catch {
    return false;
  }
}

async function ownedLoopDevices(effect) {
  const result = await runCommand("/usr/sbin/losetup", [
    "--json",
    "--output",
    "NAME,BACK-FILE",
    "--associated",
    effect.backingFile,
  ]);
  if (result.code !== 0)
    throw new HostedGateRefusal("owned_loop_identity_missing");
  let devices;
  try {
    devices = JSON.parse(result.stdout).loopdevices;
  } catch {
    throw new HostedGateRefusal("owned_loop_identity_invalid");
  }
  if (!Array.isArray(devices) || devices.length > 1)
    throw new HostedGateRefusal("owned_loop_identity_invalid");
  for (const device of devices)
    if (
      !/^\/dev\/loop[0-9]+$/u.test(device?.name ?? "") ||
      device["back-file"] !== effect.backingFile ||
      (effect.path !== undefined && device.name !== effect.path)
    )
      throw new HostedGateRefusal("owned_loop_identity_changed");
  return devices;
}

function canonicalImageIdentity(reference) {
  const match = reference.match(/^(.+)@sha256:([a-f0-9]{64})$/u);
  if (match === null)
    throw new HostedGateRefusal("owned_image_reference_invalid");
  const slash = match[1].lastIndexOf("/");
  const colon = match[1].lastIndexOf(":");
  return {
    digest: match[2],
    repoDigest: `${colon > slash ? match[1].slice(0, colon) : match[1]}@sha256:${match[2]}`,
  };
}

export function validateOwnedImageInspection(effect, result) {
  const expected = canonicalImageIdentity(effect.reference);
  const expectedTag = effect.reference.slice(0, effect.reference.indexOf("@"));
  if (
    result.code === 1 &&
    new Set(["", "[]"]).has(result.stdout.trim()) &&
    /No such image/u.test(result.stderr)
  )
    return undefined;
  if (result.code !== 0)
    throw new HostedGateRefusal("owned_image_probe_failed");
  let item;
  try {
    const decoded = JSON.parse(result.stdout);
    if (!Array.isArray(decoded) || decoded.length !== 1) throw new Error();
    [item] = decoded;
  } catch {
    throw new HostedGateRefusal("owned_image_identity_invalid");
  }
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(item?.Id ?? "") ||
    !Array.isArray(item?.RepoDigests) ||
    item.RepoDigests.length !== 1 ||
    item.RepoDigests[0] !== expected.repoDigest ||
    !Array.isArray(item?.RepoTags) ||
    item.RepoTags.length > 1 ||
    item.RepoTags.some((value) => value !== expectedTag) ||
    (effect.status === "applied" &&
      (effect.digest !== expected.digest ||
        effect.imageId !== item.Id ||
        effect.repoDigest !== expected.repoDigest ||
        JSON.stringify(effect.repoTags) !== JSON.stringify(item.RepoTags)))
  )
    throw new HostedGateRefusal("owned_image_identity_changed");
  return item;
}

export function assertOwnedImageOutsideBaseline(identity, baseline) {
  if (
    !Array.isArray(baseline) ||
    baseline.some((item) => item?.id === identity?.Id)
  )
    throw new HostedGateRefusal("owned_image_baseline_collision");
}

export function validateOwnedMountInspection(effect, result) {
  if (result.code === 1 && result.stdout.trim() === "") return undefined;
  if (result.code !== 0)
    throw new HostedGateRefusal("owned_mount_probe_failed");
  let item;
  try {
    const filesystems = JSON.parse(result.stdout).filesystems;
    if (!Array.isArray(filesystems) || filesystems.length !== 1)
      throw new Error();
    [item] = filesystems;
  } catch {
    throw new HostedGateRefusal("owned_mount_identity_invalid");
  }
  const options = item.options.split(",").sort();
  if (
    item.source !== effect.device ||
    item.target !== effect.path ||
    item.fstype !== "xfs" ||
    !options.includes("nodev") ||
    !options.includes("nosuid") ||
    (!options.includes("prjquota") && !options.includes("pquota")) ||
    (effect.status === "applied" &&
      (effect.mountIdentity?.source !== item.source ||
        effect.mountIdentity?.target !== item.target ||
        effect.mountIdentity?.fstype !== item.fstype ||
        JSON.stringify(effect.mountIdentity?.options) !==
          JSON.stringify(options)))
  )
    throw new HostedGateRefusal("owned_mount_identity_changed");
  return item;
}

async function proveOwnedRuntimeAbsent(state) {
  for (const invocation of ["cleanup-2", "cleanup-1", "gate"])
    await recoverGateChild(state, invocation);
  const processes = await processInventory();
  if (
    processes.some((item) =>
      item.cgroup
        .split("\n")
        .some((line) => line.includes(state.context.runId)),
    )
  )
    throw new HostedGateRefusal("owned_process_cleanup_unproven");
  const systemctl =
    state.executables?.systemctl ?? state.bootstrapExecutables?.systemctl;
  const docker =
    state.executables?.docker ?? state.bootstrapExecutables?.docker;
  const units = await runCommand(systemctl, [
    "list-units",
    "--all",
    "--no-legend",
    "--plain",
    `${state.context.runId}*`,
  ]);
  if (units.code !== 0 || units.stdout.trim() !== "")
    throw new HostedGateRefusal("owned_unit_cleanup_unproven");
  const containers = await runCommand(docker, [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=workload-funnel.production-gate.run=${state.context.runId}`,
  ]);
  if (containers.code !== 0 || containers.stdout.trim() !== "")
    throw new HostedGateRefusal("owned_container_cleanup_unproven");
}

export function validateSyntheticIdentityForCleanup(effect, observed) {
  if (observed.code === 2) return false;
  if (
    observed.code !== 0 ||
    observed.stdout.trim() !== effect.tuple ||
    observed.stdout.trim().split("\n").length !== 1
  )
    throw new HostedGateRefusal("synthetic_identity_changed");
  return true;
}

async function removeSyntheticIdentity(database, executable, effect) {
  const observed = await runCommand("/usr/bin/getent", [database, effect.name]);
  if (!validateSyntheticIdentityForCleanup(effect, observed)) return;
  await required(
    executable,
    [effect.name],
    "synthetic_identity_cleanup_failed",
  );
}

export function productionCleanupEvidenceRequired(state) {
  const gate = state.gateInvocations.find((item) => item.id === "gate");
  return gate !== undefined && gate.outcome !== "never-spawned";
}

async function removePackages(effect) {
  for (const item of [
    {
      path: effect.pgdgMetadata.keyringPath,
      sha256: effect.pgdgMetadata.keyringSha256,
    },
    {
      path: effect.pgdgMetadata.keySourcePath,
      sha256: effect.pgdgMetadata.keySourceSha256,
    },
    {
      path: effect.pgdgMetadata.sourceListPath,
      sha256: effect.pgdgMetadata.sourceListSha256,
    },
    ...effect.pgdgMetadata.lists,
  ]) {
    const identity = await inspectPathIdentity(item.path);
    if (
      identity.kind !== "file" ||
      identity.symlink ||
      identity.uid !== 0 ||
      identity.gid !== 0 ||
      (identity.mode & 0o022) !== 0 ||
      identity.sha256 !== item.sha256
    )
      throw new HostedGateRefusal("postgres_metadata_identity_changed");
  }
  let actions = classifyOwnedPackagePlan(
    effect.plan,
    await installedPackageInventory(),
  );
  if (actions.restore.length > 0) {
    const restoreArguments = actions.restore.map(
      (item) => `${item.name}=${item.version}`,
    );
    await requireBoundedPackageSimulation(
      [
        "--simulate",
        "install",
        "--allow-downgrades",
        "--no-install-recommends",
        "--no-remove",
        "--",
        ...restoreArguments,
      ],
      new Set(effect.plan.map((item) => item.name)),
    );
    await required(
      "/usr/bin/apt-get",
      [
        "install",
        "--allow-downgrades",
        "--no-install-recommends",
        "--no-remove",
        "--yes",
        "--",
        ...restoreArguments,
      ],
      "owned_package_restore_failed",
      { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
    );
  }
  actions = classifyOwnedPackagePlan(
    effect.plan,
    await installedPackageInventory(),
  );
  if (actions.remove.length > 0) {
    await requireBoundedPackageSimulation(
      ["--simulate", "remove", "--purge", "--", ...actions.remove],
      new Set(actions.remove),
    );
    await required(
      "/usr/bin/apt-get",
      ["remove", "--purge", "--yes", "--", ...actions.remove],
      "owned_package_cleanup_failed",
      { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
    );
  }
  actions = classifyOwnedPackagePlan(
    effect.plan,
    await installedPackageInventory(),
  );
  if (actions.remove.length !== 0 || actions.restore.length !== 0)
    throw new HostedGateRefusal("owned_package_cleanup_failed");
}

async function requireBoundedPackageSimulation(arguments_, allowed) {
  const output = await required(
    "/usr/bin/apt-get",
    arguments_,
    "owned_package_cleanup_plan_failed",
    { maxOutputBytes: 16 * 1024 * 1024 },
  );
  const changed = output
    .split("\n")
    .filter((line) => line.startsWith("Inst ") || line.startsWith("Remv "))
    .map((line) => line.split(/\s+/u)[1]);
  const accepted = (name) =>
    allowed.has(name) ||
    [...allowed].some(
      (candidate) =>
        candidate.startsWith(`${name}:`) || name.startsWith(`${candidate}:`),
    );
  if (changed.length < 1 || changed.some((name) => !accepted(name)))
    throw new HostedGateRefusal("owned_package_cleanup_plan_unbounded");
}

export async function cleanupHost(context, dependencies = {}) {
  const proveZeroResidue = dependencies.proveZeroResidue ?? verifyZeroResidue;
  const recoverChild = dependencies.recoverChild ?? recoverGateChild;
  const proveRuntimeAbsent =
    dependencies.proveRuntimeAbsent ?? proveOwnedRuntimeAbsent;
  const writeEvidence =
    dependencies.writeEvidence ?? writeRecoverableJsonAtomically;
  const finalizeState =
    dependencies.finalizeState ?? finalizeCleanedControlState;
  const readEvidence = dependencies.readEvidence ?? readCleanedEvidence;
  const tombstone = await readCleanupTombstone(context);
  if (tombstone !== undefined) {
    const evidence = await readEvidence(context);
    if (evidence.state.journalChecksum !== tombstone.journalChecksum)
      throw new HostedGateRefusal("cleanup_tombstone_evidence_mismatch");
    await finalizeState(tombstone);
    return evidence.cleanup;
  }
  if (!(await exists(context.controlRoot))) {
    const evidence = await readEvidence(context);
    await proveZeroResidue(context);
    return evidence.cleanup;
  }
  const state = await readHostState(context);
  const recoveryCertain = await gateCleanupCertain(context);
  const steps = [
    {
      id: "recover_exact_gate_children",
      run: async () => {
        for (const invocation of ["cleanup-2", "cleanup-1", "gate"])
          await recoverChild(state, invocation);
      },
    },
    {
      id: "gate_cleanup_certain",
      requiresPriorSuccess: true,
      run: async () => {
        if (productionCleanupEvidenceRequired(state) && !recoveryCertain)
          throw new HostedGateRefusal("production_gate_cleanup_failed");
      },
    },
    {
      id: "owned_runtime_absent",
      requiresPriorSuccess: true,
      run: () => proveRuntimeAbsent(state),
    },
  ];

  for (const effect of state.effects.filter(
    (candidate) => candidate.kind === "docker-image",
  ))
    steps.push(
      effectStep(state, effect.id, async (recorded) => {
        const docker =
          state.executables?.docker ?? state.bootstrapExecutables?.docker;
        const inspected = await runCommand(docker, [
          "image",
          "inspect",
          recorded.reference,
        ]);
        const identity = validateOwnedImageInspection(recorded, inspected);
        if (identity === undefined) return;
        assertOwnedImageOutsideBaseline(identity, state.dockerBaseline);
        const result = await runCommand(docker, [
          "image",
          "rm",
          "--force",
          identity.Id,
        ]);
        if (result.code !== 0)
          throw new HostedGateRefusal("owned_image_cleanup_failed");
      }),
    );
  if (getHostEffect(state, "synthetic-user") !== undefined)
    steps.push(
      effectStep(state, "synthetic-user", (effect) =>
        removeSyntheticIdentity("passwd", "/usr/sbin/userdel", effect),
      ),
    );
  if (getHostEffect(state, "synthetic-group") !== undefined)
    steps.push(
      effectStep(state, "synthetic-group", (effect) =>
        removeSyntheticIdentity("group", "/usr/sbin/groupdel", effect),
      ),
    );
  if (getHostEffect(state, "xfs-mount") !== undefined)
    steps.push(
      effectStep(state, "xfs-mount", async (effect) => {
        const result = await runCommand("/usr/bin/findmnt", [
          "--json",
          "--output",
          "SOURCE,TARGET,FSTYPE,OPTIONS",
          "--mountpoint",
          effect.path,
        ]);
        if (validateOwnedMountInspection(effect, result) === undefined) return;
        await required(
          "/usr/bin/umount",
          [effect.path],
          "owned_mount_cleanup_failed",
        );
      }),
    );
  if (getHostEffect(state, "loop-device") !== undefined)
    steps.push(
      effectStep(state, "loop-device", async (effect) => {
        const devices = await ownedLoopDevices(effect);
        if (devices.length === 1)
          await required(
            "/usr/sbin/losetup",
            ["--detach", devices[0].name],
            "owned_loop_cleanup_failed",
          );
      }),
    );
  if (getHostEffect(state, "packages") !== undefined)
    steps.push(
      effectStep(state, "packages", (effect) => removePackages(effect)),
    );
  if (getHostEffect(state, "sandbox-parent") !== undefined)
    steps.push(
      effectStep(state, "sandbox-parent", async () => {
        await rm(context.sandboxRoot, { force: true, recursive: true });
        if (await exists(SANDBOX_PARENT)) await rmdir(SANDBOX_PARENT);
        if (await exists(dirname(SANDBOX_PARENT)))
          await rmdir(dirname(SANDBOX_PARENT));
      }),
    );
  if (getHostEffect(state, "allocation-mount-point") !== undefined)
    steps.push(
      effectStep(state, "allocation-mount-point", async () => {
        if (await exists(ALLOCATION_MOUNT)) await rmdir(ALLOCATION_MOUNT);
      }),
    );
  if (getHostEffect(state, "loop-image") !== undefined)
    steps.push(
      effectStep(state, "loop-image", async (effect) => {
        if (!(await exists(effect.path))) return;
        const identity = await lstat(effect.path);
        if (
          !identity.isFile() ||
          identity.isSymbolicLink() ||
          identity.uid !== 0 ||
          identity.gid !== 0 ||
          identity.size !== effect.size ||
          (effect.status === "applied" &&
            (identity.dev !== effect.dev || identity.ino !== effect.ino))
        )
          throw new HostedGateRefusal("owned_loop_image_identity_changed");
        await rm(effect.path);
      }),
    );
  if (getHostEffect(state, "project-quota-helper") !== undefined)
    steps.push(
      effectStep(state, "project-quota-helper", async (effect) => {
        if (await exists(effect.path)) {
          const identity = await inspectPathIdentity(effect.path);
          if (
            identity.kind !== "file" ||
            identity.symlink ||
            identity.uid !== 0 ||
            identity.gid !== 0 ||
            (identity.mode & 0o022) !== 0 ||
            identity.sha256 !== effect.expectedSha256
          )
            throw new HostedGateRefusal("owned_helper_identity_changed");
          await rm(effect.path);
        }
        const parent = dirname(effect.path);
        if (await exists(parent)) await rmdir(parent);
      }),
    );
  if (getHostEffect(state, "host-root") !== undefined)
    steps.push(
      effectStep(state, "host-root", async (effect) => {
        if (!(await exists(effect.path))) return;
        const identity = await lstat(effect.path);
        if (
          !identity.isDirectory() ||
          identity.isSymbolicLink() ||
          identity.uid !== 0 ||
          identity.gid !== 0
        )
          throw new HostedGateRefusal("owned_host_root_identity_changed");
        await rm(effect.path, { recursive: true });
      }),
    );
  const effectIds = new Set(state.effects.map((effect) => effect.id));
  const expectedOrder = CLEANUP_EFFECT_ORDER.filter((id) => effectIds.has(id));
  const observedOrder = steps
    .map((step) => step.id)
    .filter((id) => effectIds.has(id));
  if (JSON.stringify(observedOrder) !== JSON.stringify(expectedOrder))
    throw new HostedGateRefusal("host_cleanup_order_invalid");
  steps.push({
    id: "cleanup_journal_complete",
    requiresPriorSuccess: true,
    run: () => markHostCleaned(state),
  });

  const cleanup = await executeCleanupSteps(steps);
  requireCertainCleanup(cleanup);
  await proveZeroResidue(context, { state, write: true, writeEvidence });
  const journalEvidence = `${context.artifactRoot}/host-state-evidence.json`;
  await writeEvidence(journalEvidence, state, { mode: 0o444 });
  await writeEvidence(
    `${context.artifactRoot}/host-cleanup.json`,
    {
      ...cleanup,
      runId: context.runId,
      schemaVersion: HOSTED_GATE_SCHEMA,
    },
    { mode: 0o444 },
  );
  await finalizeState(state);
  return cleanup;
}
