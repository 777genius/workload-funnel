import { lstat, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ALLOCATION_MOUNT,
  HOSTED_GATE_SCHEMA,
  PINNED_IMAGES,
  POSTGRES_CLIENT,
  SANDBOX_PARENT,
  SYNTHETIC_USER,
} from "./constants.mjs";
import { HostedGateRefusal } from "./contract.mjs";
import {
  classifyForeignProcesses,
  dockerImageInventory,
  processInventory,
} from "./host-observation.mjs";
import { normalizeDockerImageInventory } from "./docker-image-baseline.mjs";
import {
  classifyOwnedPackagePlan,
  installedPackageInventory,
} from "./host-tools.mjs";
import { runCommand } from "./process-runner.mjs";
import { writeRecoverableJsonAtomically } from "./recoverable-json.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function commandAbsent(executable, arguments_) {
  const result = await runCommand(executable, arguments_);
  return (
    (result.code === 0 || result.code === 1) && result.stdout.trim() === ""
  );
}

export function classifyZeroResidueFailure(evidence) {
  const checks = evidence.checks;
  for (const [failed, reason] of [
    [checks.paths.length > 0, "owned_path_residue"],
    [checks.userExists, "synthetic_user_residue"],
    [checks.groupExists, "synthetic_group_residue"],
    [!checks.mountAbsent, "owned_mount_residue"],
    [!checks.loopAbsent, "owned_loop_residue"],
    [!checks.processProbeCertain, "process_residue_probe_uncertain"],
    [checks.ownedProcesses.length > 0, "owned_process_residue"],
    [checks.foreignProcesses.length > 0, "foreign_process_residue"],
    [!checks.packageProbesCertain, "package_residue_probe_uncertain"],
    [checks.packages.length > 0, "owned_package_residue"],
    [!checks.imageProbesCertain, "image_residue_probe_uncertain"],
    [checks.images.length > 0, "owned_image_residue"],
    [!checks.imageBaselineMatches, "docker_image_baseline_drift"],
    [checks.containers !== "", "docker_container_residue"],
    [checks.networks.length > 0, "docker_network_residue"],
    [checks.volumes !== "", "docker_volume_residue"],
    [checks.units !== "", "systemd_unit_residue"],
  ])
    if (failed) return reason;
  return "owned_residue_unclassified";
}

export async function verifyZeroResidue(context, options = {}) {
  let hostState = options.state;
  if (hostState === undefined)
    for (const statePath of [
      `${context.controlRoot}/host-state.json`,
      `${context.artifactRoot}/host-state-evidence.json`,
    ]) {
      try {
        hostState = JSON.parse(await readFile(statePath, "utf8"));
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  const paths = [
    context.hostRoot,
    `${context.controlRoot}.cleanup-tombstone`,
    context.sandboxRoot,
    SANDBOX_PARENT,
    dirname(SANDBOX_PARENT),
    ALLOCATION_MOUNT,
    "/usr/libexec/workload-funnel/linux-project-quota",
    "/usr/lib/postgresql/18",
    "/etc/apt/sources.list.d/workload-funnel-postgresql.list",
    "/usr/share/keyrings/workload-funnel-postgresql.gpg",
  ];
  if (options.state === undefined) paths.push(context.controlRoot);
  const remainingPaths = [];
  for (const path of paths) if (await exists(path)) remainingPaths.push(path);
  const user = await runCommand("/usr/bin/getent", ["passwd", SYNTHETIC_USER]);
  const group = await runCommand("/usr/bin/getent", ["group", SYNTHETIC_USER]);
  const mountAbsent = await commandAbsent("/usr/bin/findmnt", [
    "--noheadings",
    "--mountpoint",
    ALLOCATION_MOUNT,
  ]);
  const loopEffect = hostState?.effects?.find(
    (item) => item.id === "loop-device",
  );
  const loopDevice = loopEffect?.path ?? hostState?.loopDevice;
  const loopAbsent =
    typeof loopDevice === "string"
      ? await commandAbsent("/usr/sbin/losetup", [loopDevice])
      : await commandAbsent("/usr/sbin/losetup", [
          "--associated",
          loopEffect?.backingFile ??
            `${context.hostRoot}/workload-funnel-prjquota.xfs`,
        ]);
  let foreignProcesses = [];
  let ownedProcesses = [];
  let processProbeCertain = true;
  let observedProcessCount = null;
  try {
    const inventory = await processInventory();
    observedProcessCount = inventory.length;
    ownedProcesses = inventory.filter((item) =>
      item.cgroup.split("\n").some((line) => line.includes(context.runId)),
    );
    foreignProcesses = classifyForeignProcesses(inventory, {
      currentPid: process.pid,
      runnerUid: Number(process.env.SUDO_UID),
    });
  } catch {
    processProbeCertain = false;
  }
  const packageResidue = [];
  let packageProbesCertain = true;
  const packageEffect = hostState?.effects?.find(
    (item) => item.id === "packages",
  );
  if (packageEffect?.plan !== undefined) {
    try {
      const actions = classifyOwnedPackagePlan(
        packageEffect.plan,
        await installedPackageInventory(),
      );
      for (const name of actions.remove) packageResidue.push(`remove:${name}`);
      for (const item of actions.restore)
        packageResidue.push(`restore:${item.name}`);
    } catch {
      packageProbesCertain = false;
    }
  } else {
    const result = await runCommand("/usr/bin/dpkg-query", [
      "--show",
      POSTGRES_CLIENT.packageName,
    ]);
    if (result.code === 0) packageResidue.push(POSTGRES_CLIENT.packageName);
    else if (result.code !== 1) packageProbesCertain = false;
  }
  const images = [];
  let imageProbesCertain = true;
  for (const reference of Object.values(PINNED_IMAGES)) {
    const result = await runCommand("/usr/bin/docker", [
      "image",
      "inspect",
      reference,
    ]);
    if (result.code === 0) images.push(reference);
    else if (result.code !== 1) imageProbesCertain = false;
  }
  let imageBaseline = [];
  let imageInventory = [];
  let imageBaselineMatches = false;
  try {
    imageBaseline = normalizeDockerImageInventory(
      hostState?.dockerBaseline ?? [],
    );
    imageInventory = await dockerImageInventory();
    imageBaselineMatches = isDeepStrictEqual(imageInventory, imageBaseline);
  } catch {
    imageProbesCertain = false;
  }
  const containers = await runCommand("/usr/bin/docker", [
    "container",
    "ls",
    "--all",
    "--quiet",
  ]);
  const networks = await runCommand("/usr/bin/docker", [
    "network",
    "ls",
    "--format",
    "{{.Name}}",
  ]);
  const volumes = await runCommand("/usr/bin/docker", [
    "volume",
    "ls",
    "--quiet",
  ]);
  const units = await runCommand("/usr/bin/systemctl", [
    "list-units",
    "--all",
    "--no-legend",
    "--plain",
    "workload-funnel-*",
    "wf-production-gate-*",
  ]);
  const remainingNetworks = networks.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((name) => !new Set(["bridge", "host", "none"]).has(name));
  const evidence = Object.freeze({
    checks: Object.freeze({
      containers: containers.stdout.trim(),
      groupExists: group.code === 0,
      images: Object.freeze(images),
      imageBaseline,
      imageBaselineMatches,
      imageInventory,
      imageProbesCertain,
      loopAbsent,
      mountAbsent,
      networks: Object.freeze(remainingNetworks),
      packageProbesCertain,
      packages: Object.freeze(packageResidue),
      paths: Object.freeze(remainingPaths),
      foreignProcesses: Object.freeze(foreignProcesses),
      observedProcessCount,
      ownedProcesses: Object.freeze(ownedProcesses),
      processProbeCertain,
      units: units.stdout.trim(),
      userExists: user.code === 0,
      volumes: volumes.stdout.trim(),
    }),
    runId: context.runId,
    schemaVersion: HOSTED_GATE_SCHEMA,
    zeroResidue:
      remainingPaths.length === 0 &&
      user.code === 2 &&
      group.code === 2 &&
      mountAbsent &&
      loopAbsent &&
      processProbeCertain &&
      ownedProcesses.length === 0 &&
      foreignProcesses.length === 0 &&
      packageProbesCertain &&
      packageResidue.length === 0 &&
      imageProbesCertain &&
      images.length === 0 &&
      imageBaselineMatches &&
      containers.code === 0 &&
      containers.stdout.trim() === "" &&
      networks.code === 0 &&
      remainingNetworks.length === 0 &&
      volumes.code === 0 &&
      volumes.stdout.trim() === "" &&
      units.code === 0 &&
      units.stdout.trim() === "",
  });
  if (!evidence.zeroResidue)
    throw new HostedGateRefusal(classifyZeroResidueFailure(evidence));
  const residuePath = `${context.artifactRoot}/residue.json`;
  const writeEvidence = options.writeEvidence ?? writeRecoverableJsonAtomically;
  await writeEvidence(residuePath, evidence, {
    acceptExisting: (candidate) => {
      validateResidue(candidate, context);
      return true;
    },
    mode: 0o444,
  });
  return evidence;
}

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

function exactObject(value, keys, code) {
  const expected = new Set(keys);
  refuse(
    value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== expected.size ||
      Object.keys(value).some((key) => !expected.has(key)),
    code,
  );
  return value;
}

export function validateResidue(residue, context) {
  exactObject(
    residue,
    ["checks", "runId", "schemaVersion", "zeroResidue"],
    "residue_evidence_invalid",
  );
  const checks = exactObject(
    residue.checks,
    [
      "containers",
      "groupExists",
      "imageProbesCertain",
      "imageBaseline",
      "imageBaselineMatches",
      "imageInventory",
      "images",
      "loopAbsent",
      "mountAbsent",
      "networks",
      "packageProbesCertain",
      "packages",
      "paths",
      "foreignProcesses",
      "observedProcessCount",
      "ownedProcesses",
      "processProbeCertain",
      "units",
      "userExists",
      "volumes",
    ],
    "residue_evidence_invalid",
  );
  refuse(
    residue.schemaVersion !== HOSTED_GATE_SCHEMA ||
      residue.runId !== context.runId ||
      residue.zeroResidue !== true ||
      checks.containers !== "" ||
      checks.groupExists !== false ||
      checks.imageProbesCertain !== true ||
      checks.imageBaselineMatches !== true ||
      !Array.isArray(checks.images) ||
      checks.images.length !== 0 ||
      checks.loopAbsent !== true ||
      checks.mountAbsent !== true ||
      !Array.isArray(checks.networks) ||
      checks.networks.length !== 0 ||
      checks.packageProbesCertain !== true ||
      !Array.isArray(checks.packages) ||
      checks.packages.length !== 0 ||
      !Array.isArray(checks.paths) ||
      checks.paths.length !== 0 ||
      !Array.isArray(checks.foreignProcesses) ||
      checks.foreignProcesses.length !== 0 ||
      !Number.isSafeInteger(checks.observedProcessCount) ||
      checks.observedProcessCount < 1 ||
      !Array.isArray(checks.ownedProcesses) ||
      checks.ownedProcesses.length !== 0 ||
      checks.processProbeCertain !== true ||
      checks.units !== "" ||
      checks.userExists !== false ||
      checks.volumes !== "",
    "residue_evidence_invalid",
  );
  let baseline;
  let inventory;
  try {
    baseline = normalizeDockerImageInventory(checks.imageBaseline);
    inventory = normalizeDockerImageInventory(checks.imageInventory);
  } catch {
    throw new HostedGateRefusal("residue_evidence_invalid");
  }
  refuse(
    !isDeepStrictEqual(checks.imageBaseline, baseline) ||
      !isDeepStrictEqual(checks.imageInventory, inventory) ||
      !isDeepStrictEqual(baseline, inventory),
    "residue_evidence_invalid",
  );
}
