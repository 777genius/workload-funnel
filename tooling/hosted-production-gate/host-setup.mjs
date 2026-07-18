import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";

import {
  ALLOCATION_MOUNT,
  AWS_CLI,
  HOSTED_GATE_SCHEMA,
  HYPERQUEUE,
  LOOP_IMAGE_BYTES,
  PINNED_IMAGES,
  POSTGRES_CLIENT,
  RUNTIME_PACKAGE_NAMES,
  SANDBOX_PARENT,
  SYNTHETIC_USER,
} from "./constants.mjs";
import {
  HostedGateRefusal,
  validateHostAdmission,
  validateTrustedIdentity,
  verifySha256,
} from "./contract.mjs";
import { observePristineHost } from "./host-observation.mjs";
import {
  applyHostEffect,
  createHostState,
  markHostPrepared,
  prepareHostEffect,
  saveHostState,
} from "./host-state.mjs";
import {
  downloadHttps,
  exactAppliedPackageChanges,
  exactPackagePlan,
  installPreparedPostgresClient,
  installedPackageInventory,
  installExactAwsCli,
  parseAptSimulation,
  prepareExactPostgresClient,
} from "./host-tools.mjs";
import {
  createReviewManifest,
  collectReviewedFiles,
  inspectExecutable,
  installReviewManifest,
  writeJsonAtomically,
} from "./review-manifest.mjs";
import { runCommand } from "./process-runner.mjs";
import {
  installRuntimeCustody,
  removeUnreviewedTrees,
} from "./runtime-custody.mjs";

function code(error) {
  return error instanceof HostedGateRefusal || error instanceof Error
    ? error.message
    : "hosted_gate_prepare_failed";
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

async function downloadHyperQueue(state) {
  const archivePath = `${state.hostRoot}/fixtures/${HYPERQUEUE.archiveName}`;
  const bytes = await downloadHttps(HYPERQUEUE.downloadUrl);
  verifySha256(
    bytes,
    HYPERQUEUE.archiveSha256,
    "hyperqueue_archive_checksum_mismatch",
  );
  await writeFile(archivePath, bytes, { flag: "wx", mode: 0o444 });
  const extractRoot = `${state.hostRoot}/hq-extract`;
  await mkdir(extractRoot, { mode: 0o700 });
  const listing = await required(
    "/usr/bin/tar",
    ["--list", "--gzip", "--file", archivePath],
    "hyperqueue_archive_inventory_failed",
  );
  const paths = listing.trim().split("\n").filter(Boolean);
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        path.startsWith("/") ||
        path.split("/").some((segment) => segment === ".." || segment === ""),
    ) ||
    paths.filter((path) => basename(path) === "hq").length !== 1
  )
    throw new HostedGateRefusal("hyperqueue_archive_paths_unsafe");
  await required(
    "/usr/bin/tar",
    [
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      extractRoot,
      "--no-same-owner",
    ],
    "hyperqueue_archive_extract_failed",
  );
  const candidates = [];
  const visit = async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = `${root}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new HostedGateRefusal("hyperqueue_archive_symlink_refused");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name === "hq") candidates.push(path);
      else if (!entry.isFile())
        throw new HostedGateRefusal("hyperqueue_archive_entry_invalid");
    }
  };
  await visit(extractRoot);
  if (candidates.length !== 1)
    throw new HostedGateRefusal("hyperqueue_archive_binary_not_unique");
  const hqPath = `${state.hostRoot}/bin/hq`;
  await copyFile(candidates[0], hqPath);
  await chmod(hqPath, 0o555);
  await chown(hqPath, 0, 0);
  await rm(extractRoot, { force: true, recursive: true });
  return Object.freeze({ archivePath, hqPath });
}

async function assertExactBuiltCheckout(context) {
  const workspaceIdentity = await lstat(context.workspace);
  if (
    (await realpath(context.workspace)) !== context.workspace ||
    !workspaceIdentity.isDirectory() ||
    workspaceIdentity.isSymbolicLink()
  )
    throw new HostedGateRefusal("checked_out_workspace_identity_untrusted");
  const head = (
    await required(
      "/usr/bin/git",
      ["-C", context.workspace, "rev-parse", "--verify", "HEAD"],
      "checked_out_commit_unproven",
    )
  ).trim();
  if (head !== context.commit)
    throw new HostedGateRefusal("checked_out_commit_mismatch");
  const status = await required(
    "/usr/bin/git",
    [
      "-C",
      context.workspace,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ],
    "checked_out_commit_unproven",
  );
  if (status !== "")
    throw new HostedGateRefusal("tracked_source_drift_after_build");
  for (const path of [
    "packages/executor-systemd/dist/features/capability-discovery/index.js",
    "packages/executor-systemd/dist/features/cgroup-resource-mapping/index.js",
    "packages/executor-systemd/dist/native/linux-project-quota",
    "packages/node-execution/dist/features/resource-enforcement/index.js",
  ])
    if (!(await exists(`${context.workspace}/${path}`)))
      throw new HostedGateRefusal("exact_commit_build_incomplete");
  await collectReviewedFiles(context.workspace, {
    expectedGid: workspaceIdentity.gid,
    expectedUid: workspaceIdentity.uid,
  });
}

async function sealSource(state, reviewedDownloads) {
  await assertExactBuiltCheckout(state.context);
  const reviewRoot = `${state.hostRoot}/source`;
  await required(
    "/usr/bin/cp",
    ["--archive", "--", state.context.workspace, reviewRoot],
    "review_source_copy_failed",
    { maxOutputBytes: 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  await removeUnreviewedTrees(reviewRoot);
  const runtime = await installRuntimeCustody({
    packageNames: RUNTIME_PACKAGE_NAMES,
    reviewRoot,
    workspace: state.context.workspace,
  });
  const downloadsRoot = `${reviewRoot}/reviewed-host-downloads`;
  await mkdir(downloadsRoot, { mode: 0o700 });
  const installedDownloads = [];
  for (const item of reviewedDownloads) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(item.name))
      throw new HostedGateRefusal("reviewed_download_name_invalid");
    const destination = `${downloadsRoot}/${item.name}`;
    await copyFile(item.path, destination);
    await chmod(destination, 0o400);
    installedDownloads.push(destination);
  }
  await required(
    "/usr/bin/chown",
    ["--recursive", "--no-dereference", "root:root", "--", reviewRoot],
    "review_source_owner_seal_failed",
    { maxOutputBytes: 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  await required(
    "/usr/bin/chmod",
    ["--recursive", "a-w", "--", reviewRoot],
    "review_source_mode_seal_failed",
    { maxOutputBytes: 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  return Object.freeze({
    reviewRoot,
    reviewedDownloads: Object.freeze(installedDownloads),
    runtimeBundle: runtime.bundle,
    runtimeCustody: runtime.packages,
    runtimeIntegrity: runtime.integrity,
  });
}

async function installExecutable(source, destination, mode = 0o555) {
  await mkdir(dirname(destination), { mode: 0o755, recursive: true });
  await copyFile(source, destination, 0);
  await chown(destination, 0, 0);
  await chmod(destination, mode);
  return realpath(destination);
}

async function pullPinnedImages(state) {
  const imageIdentities = [];
  for (const [name, reference] of Object.entries(PINNED_IMAGES)) {
    const effectId = `docker-image:${name.replaceAll(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}`;
    await prepareHostEffect(state, {
      id: effectId,
      kind: "docker-image",
      reference,
    });
    await required(
      "/usr/bin/docker",
      ["image", "pull", "--platform", "linux/amd64", reference],
      "pinned_image_pull_failed",
      { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 15 * 60_000 },
    );
    const digest = reference.match(/@sha256:([a-f0-9]{64})$/u)?.[1];
    const inspected = JSON.parse(
      await required(
        "/usr/bin/docker",
        ["image", "inspect", reference],
        "pinned_image_identity_unproven",
      ),
    );
    const repository = reference.slice(0, reference.indexOf("@"));
    const slash = repository.lastIndexOf("/");
    const colon = repository.lastIndexOf(":");
    const digestReference = `${
      colon > slash ? repository.slice(0, colon) : repository
    }@sha256:${digest}`;
    if (
      digest === undefined ||
      !Array.isArray(inspected) ||
      inspected.length !== 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(inspected[0]?.Id ?? "") ||
      !Array.isArray(inspected[0]?.RepoDigests) ||
      inspected[0].RepoDigests.length !== 1 ||
      inspected[0].RepoDigests[0] !== digestReference ||
      !Array.isArray(inspected[0]?.RepoTags) ||
      inspected[0].RepoTags.some(
        (value) => value !== reference.slice(0, reference.indexOf("@")),
      ) ||
      inspected[0].RepoTags.length > 1
    )
      throw new HostedGateRefusal("pinned_image_digest_mismatch");
    imageIdentities.push(reference);
    await applyHostEffect(state, effectId, {
      digest,
      imageId: inspected[0].Id,
      repoDigest: digestReference,
      repoTags: inspected[0].RepoTags,
    });
  }
  return Object.freeze(imageIdentities);
}

async function createSyntheticIdentity(state) {
  const [passwd, group] = await Promise.all([
    required("/usr/bin/getent", ["passwd"], "passwd_inventory_failed"),
    required("/usr/bin/getent", ["group"], "group_inventory_failed"),
  ]);
  const used = new Set(
    [...passwd.split("\n"), ...group.split("\n")]
      .filter(Boolean)
      .map((line) => Number(line.split(":")[2]))
      .filter(Number.isSafeInteger),
  );
  const uid = Array.from({ length: 300 }, (_, index) => 899 - index).find(
    (candidate) => !used.has(candidate),
  );
  if (uid === undefined)
    throw new HostedGateRefusal("synthetic_id_unavailable");
  const groupTuple = `${SYNTHETIC_USER}:x:${uid}:`;
  const passwdTuple = `${SYNTHETIC_USER}:x:${uid}:${uid}::/nonexistent:/usr/sbin/nologin`;
  await prepareHostEffect(state, {
    gid: uid,
    id: "synthetic-group",
    kind: "synthetic-group",
    name: SYNTHETIC_USER,
    tuple: groupTuple,
  });
  await required(
    "/usr/sbin/groupadd",
    ["--gid", String(uid), "--system", SYNTHETIC_USER],
    "synthetic_group_create_failed",
  );
  const observedGroup = (
    await required(
      "/usr/bin/getent",
      ["group", SYNTHETIC_USER],
      "synthetic_group_identity_missing",
    )
  ).trim();
  if (observedGroup !== groupTuple)
    throw new HostedGateRefusal("synthetic_group_identity_changed");
  await applyHostEffect(state, "synthetic-group", { tuple: observedGroup });
  await prepareHostEffect(state, {
    gid: uid,
    id: "synthetic-user",
    kind: "synthetic-user",
    name: SYNTHETIC_USER,
    tuple: passwdTuple,
    uid,
  });
  await required(
    "/usr/sbin/useradd",
    [
      "--system",
      "--uid",
      String(uid),
      "--gid",
      SYNTHETIC_USER,
      "--home-dir",
      "/nonexistent",
      "--no-create-home",
      "--shell",
      "/usr/sbin/nologin",
      SYNTHETIC_USER,
    ],
    "synthetic_user_create_failed",
  );
  const observedUser = (
    await required(
      "/usr/bin/getent",
      ["passwd", SYNTHETIC_USER],
      "synthetic_user_identity_missing",
    )
  ).trim();
  if (observedUser !== passwdTuple)
    throw new HostedGateRefusal("synthetic_user_identity_changed");
  await applyHostEffect(state, "synthetic-user", { tuple: observedUser });
}

async function createQuotaFilesystem(state) {
  const mkfs = await realpath("/usr/sbin/mkfs.xfs");
  validateTrustedIdentity(await inspectExecutable(mkfs), {
    executable: true,
    expectedPath: mkfs,
  });
  const imagePath = `${state.hostRoot}/workload-funnel-prjquota.xfs`;
  await prepareHostEffect(state, {
    id: "loop-image",
    kind: "loop-image",
    path: imagePath,
    size: LOOP_IMAGE_BYTES,
  });
  await required(
    "/usr/bin/truncate",
    ["--size", String(LOOP_IMAGE_BYTES), imagePath],
    "loop_image_create_failed",
  );
  const loopImageIdentity = await lstat(imagePath);
  if (
    !loopImageIdentity.isFile() ||
    loopImageIdentity.isSymbolicLink() ||
    loopImageIdentity.uid !== 0 ||
    loopImageIdentity.gid !== 0 ||
    loopImageIdentity.size !== LOOP_IMAGE_BYTES
  )
    throw new HostedGateRefusal("loop_image_identity_invalid");
  await applyHostEffect(state, "loop-image", {
    dev: loopImageIdentity.dev,
    ino: loopImageIdentity.ino,
    size: loopImageIdentity.size,
  });
  await prepareHostEffect(state, {
    backingFile: imagePath,
    id: "loop-device",
    kind: "loop-device",
  });
  const loopDevice = (
    await required(
      "/usr/sbin/losetup",
      ["--find", "--show", "--nooverlap", imagePath],
      "loop_device_create_failed",
    )
  ).trim();
  if (!/^\/dev\/loop[0-9]+$/u.test(loopDevice))
    throw new HostedGateRefusal("loop_device_identity_invalid");
  state.loopDevice = loopDevice;
  await applyHostEffect(state, "loop-device", {
    path: loopDevice,
  });
  await required(
    mkfs,
    ["-f", "-m", "reflink=0", loopDevice],
    "xfs_format_failed",
    { maxOutputBytes: 4 * 1024 * 1024, timeoutMs: 5 * 60_000 },
  );
  await prepareHostEffect(state, {
    id: "allocation-mount-point",
    kind: "mount-point",
    path: ALLOCATION_MOUNT,
  });
  await mkdir(ALLOCATION_MOUNT, { mode: 0o755 });
  await chown(ALLOCATION_MOUNT, 0, 0);
  await applyHostEffect(state, "allocation-mount-point");
  await prepareHostEffect(state, {
    device: loopDevice,
    id: "xfs-mount",
    kind: "xfs-mount",
    options: ["nodev", "nosuid", "prjquota"],
    path: ALLOCATION_MOUNT,
  });
  await required(
    "/usr/bin/mount",
    [
      "--types",
      "xfs",
      "--options",
      "prjquota,nodev,nosuid",
      loopDevice,
      ALLOCATION_MOUNT,
    ],
    "xfs_prjquota_mount_failed",
  );
  const mount = await required(
    "/usr/bin/findmnt",
    [
      "--json",
      "--output",
      "SOURCE,TARGET,FSTYPE,OPTIONS",
      "--mountpoint",
      ALLOCATION_MOUNT,
    ],
    "xfs_prjquota_mount_unproven",
  );
  let mountIdentity;
  try {
    const filesystems = JSON.parse(mount).filesystems;
    if (!Array.isArray(filesystems) || filesystems.length !== 1)
      throw new Error();
    const item = filesystems[0];
    const options = item.options.split(",").sort();
    if (
      item.source !== loopDevice ||
      item.target !== ALLOCATION_MOUNT ||
      item.fstype !== "xfs" ||
      !options.includes("nodev") ||
      !options.includes("nosuid") ||
      (!new Set(options).has("prjquota") && !new Set(options).has("pquota"))
    )
      throw new Error();
    mountIdentity = { ...item, options };
  } catch {
    throw new HostedGateRefusal("xfs_prjquota_mount_unproven");
  }
  await applyHostEffect(state, "xfs-mount", { mountIdentity });
  for (const name of ["allocations", "project-quota"])
    await mkdir(`${ALLOCATION_MOUNT}/${name}`, { mode: 0o700 });
  await prepareHostEffect(state, {
    id: "sandbox-parent",
    kind: "sandbox-parent",
    path: SANDBOX_PARENT,
  });
  await mkdir(SANDBOX_PARENT, { mode: 0o700, recursive: true });
  await chown(dirname(SANDBOX_PARENT), 0, 0);
  await chown(SANDBOX_PARENT, 0, 0);
  await chmod(dirname(SANDBOX_PARENT), 0o755);
  await chmod(SANDBOX_PARENT, 0o700);
  await applyHostEffect(state, "sandbox-parent");
}

async function copyArtifact(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o444);
}

export async function initializeArtifacts(context) {
  let identity;
  try {
    identity = await lstat(context.artifactRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(context.artifactRoot, { mode: 0o700 });
    identity = await lstat(context.artifactRoot);
  }
  if (
    (await realpath(context.artifactRoot)) !== context.artifactRoot ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o7777) !== 0o700 ||
    (await readdir(context.artifactRoot)).length !== 0
  )
    throw new HostedGateRefusal("artifact_initialization_root_untrusted");
  await writeJsonAtomically(`${context.artifactRoot}/context.json`, {
    commit: context.commit,
    runAttempt: context.runAttempt,
    runId: context.runId,
    runNumber: context.runNumber,
    schemaVersion: HOSTED_GATE_SCHEMA,
  });
}

export async function prepareHost(context) {
  const preparedAt = new Date().toISOString();
  try {
    const observation = await observePristineHost(context);
    validateHostAdmission(observation);
    await assertExactBuiltCheckout(context);
    await writeJsonAtomically(`${context.artifactRoot}/preflight.json`, {
      admitted: true,
      observation,
      schemaVersion: HOSTED_GATE_SCHEMA,
    });
    const state = await createHostState(
      context,
      preparedAt,
      {
        docker: observation.tools.docker.path,
        systemctl: observation.tools.systemctl.path,
      },
      observation.docker.images,
    );
    await prepareHostEffect(state, {
      id: "host-root",
      kind: "host-root",
      path: context.hostRoot,
    });
    await mkdir(context.hostRoot, { mode: 0o755 });
    await mkdir(`${context.hostRoot}/bin`, { mode: 0o755 });
    await mkdir(`${context.hostRoot}/fixtures`, { mode: 0o755 });
    await applyHostEffect(state, "host-root");
    const packageBaseline = await installedPackageInventory();
    const postgresPrepared = await prepareExactPostgresClient(context.hostRoot);
    let xfsSimulation = [];
    if (!(await exists("/usr/sbin/mkfs.xfs"))) {
      await required(
        "/usr/bin/apt-get",
        ["update"],
        "signed_package_index_update_failed",
        { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
      );
      const simulation = await required(
        "/usr/bin/apt-get",
        ["--simulate", "install", "--no-install-recommends", "--", "xfsprogs"],
        "signed_package_plan_failed",
        { maxOutputBytes: 16 * 1024 * 1024 },
      );
      xfsSimulation = parseAptSimulation(simulation.stdout);
    }
    const packagePlan = exactPackagePlan(
      packageBaseline,
      postgresPrepared.packageSimulation,
      xfsSimulation,
    );
    if (
      !packagePlan.some(
        (item) =>
          item.name === POSTGRES_CLIENT.packageName &&
          item.targetVersion === POSTGRES_CLIENT.packageVersion,
      )
    )
      throw new HostedGateRefusal("bootstrap_package_plan_untrusted");
    await prepareHostEffect(state, {
      id: "packages",
      kind: "packages",
      pgdgMetadata: postgresPrepared.metadata,
      plan: packagePlan,
    });
    const postgres = await installPreparedPostgresClient(postgresPrepared);
    state.postgresClient = postgres.evidence;
    await saveHostState(state);
    if (!(await exists("/usr/sbin/mkfs.xfs")))
      await required(
        "/usr/bin/apt-get",
        [
          "install",
          "--yes",
          "--no-install-recommends",
          "--no-remove",
          "--",
          "xfsprogs",
        ],
        "signed_package_install_failed",
        { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
      );
    const packageObserved = await installedPackageInventory();
    state.packageChanges = exactAppliedPackageChanges(
      packageBaseline,
      packagePlan,
      packageObserved,
    );
    state.packagePlan = packagePlan;
    await applyHostEffect(state, "packages", {
      plan: packagePlan,
    });
    const aws = await installExactAwsCli(context.hostRoot);
    state.awsCli = aws.evidence;
    await saveHostState(state);
    const hyperqueue = await downloadHyperQueue(state);
    const sealed = await sealSource(state, [
      { name: HYPERQUEUE.archiveName, path: hyperqueue.archivePath },
      { name: "ACCC4CF8.asc", path: postgres.keyPath },
      { name: "postgresql-pgdg.list", path: postgres.sourcePath },
      { name: "aws-cli-signing-key.asc", path: aws.keyPath },
      { name: `${AWS_CLI.archiveName}.sig`, path: aws.signaturePath },
      { name: AWS_CLI.archiveName, path: aws.archivePath },
    ]);
    const { reviewRoot } = sealed;
    const node = await installExecutable(
      process.execPath,
      `${context.hostRoot}/bin/node`,
    );
    const helperSource = `${reviewRoot}/packages/executor-systemd/dist/native/linux-project-quota`;
    const helperDestination =
      "/usr/libexec/workload-funnel/linux-project-quota";
    const helperSourceIdentity = await inspectExecutable(helperSource);
    await prepareHostEffect(state, {
      expectedSha256: helperSourceIdentity.sha256,
      id: "project-quota-helper",
      kind: "executable",
      path: helperDestination,
    });
    const helper = await installExecutable(helperSource, helperDestination);
    await applyHostEffect(state, "project-quota-helper");
    const executables = Object.freeze({
      aws: aws.executable,
      docker: await realpath("/usr/bin/docker"),
      hq: hyperqueue.hqPath,
      id: await realpath("/usr/bin/id"),
      node,
      projectQuotaHelper: helper,
      psql: postgres.executable,
      systemctl: await realpath("/usr/bin/systemctl"),
      systemdAnalyze: await realpath("/usr/bin/systemd-analyze"),
      systemdRun: await realpath("/usr/bin/systemd-run"),
    });
    for (const path of Object.values(executables))
      await inspectExecutable(path);
    await pullPinnedImages(state);
    await createSyntheticIdentity(state);
    await createQuotaFilesystem(state);
    state.executables = executables;
    state.hqArchive = hyperqueue.archivePath;
    state.reviewRoot = reviewRoot;
    state.reviewedDownloads = sealed.reviewedDownloads;
    state.runtimeBundle = sealed.runtimeBundle;
    state.runtimeCustody = sealed.runtimeCustody;
    state.runtimeIntegrity = sealed.runtimeIntegrity;
    const manifest = await createReviewManifest({
      executablePaths: Object.values(executables),
      hqArchive: hyperqueue.archivePath,
      reviewId: `github:${context.commit}:${context.runNumber}:${context.runAttempt}`,
      reviewRoot,
    });
    const manifestIdentity = await installReviewManifest(
      `${context.hostRoot}/review-manifest.json`,
      manifest,
    );
    state.manifest = manifestIdentity;
    await saveHostState(state);
    await copyArtifact(
      manifestIdentity.path,
      `${context.artifactRoot}/review-manifest.json`,
    );
    await writeJsonAtomically(`${context.artifactRoot}/prepare.json`, {
      build: Object.freeze({
        commit: context.commit,
        reviewRoot,
      }),
      downloads: Object.freeze({
        awsCli: state.awsCli,
        hyperqueueArchiveSha256: HYPERQUEUE.archiveSha256,
        hyperqueueVersion: HYPERQUEUE.version,
        postgresClient: state.postgresClient,
        reviewedDownloads: state.reviewedDownloads,
      }),
      hostBootstrap: Object.freeze({
        filesystem: "xfs",
        loopDevice: state.loopDevice,
        mountOptions: Object.freeze(["nodev", "nosuid", "prjquota"]),
        packageChanges: state.packageChanges,
        privateRootModes: Object.freeze({
          allocations: 0o700,
          projectQuota: 0o700,
        }),
        syntheticUser: SYNTHETIC_USER,
      }),
      images: PINNED_IMAGES,
      prepared: true,
      preparedAt,
      reviewManifestSha256: manifestIdentity.sha256,
      runtimeBundle: state.runtimeBundle,
      runtimeCustody: state.runtimeCustody,
      runtimeIntegrity: state.runtimeIntegrity,
      runId: context.runId,
      schemaVersion: HOSTED_GATE_SCHEMA,
    });
    await markHostPrepared(state);
    return state;
  } catch (error) {
    await writeJsonAtomically(`${context.artifactRoot}/prepare.json`, {
      prepared: false,
      preparedAt,
      reason: code(error),
      runId: context.runId,
      schemaVersion: HOSTED_GATE_SCHEMA,
    }).catch(() => undefined);
    throw error;
  }
}
