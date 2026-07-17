import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { arch, release } from "node:os";
import { fileURLToPath } from "node:url";

import {
  AZURITE_FIXTURE_IMAGE,
  ARCHITECTURE_PLAN_SHA256,
  DISPOSABLE_HOST_ATTESTATION,
  GATE_SANDBOX_PARENT,
  OBJECT_FIXTURE_IMAGE,
  OWNED_NAME_PATTERN,
  POSTGRES_FIXTURE_IMAGE,
  REVIEW_MANIFEST_SCHEMA,
} from "./constants.mjs";
import {
  inspectCanonicalExecutable,
  ReviewedExecutableSet,
} from "./executable-identity.mjs";

export class GateAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = "GateAdmissionError";
    this.code = code;
  }
}

function exactOptions(argv) {
  const normalized = argv[0] === "--" ? argv.slice(1) : argv;
  if (normalized[0] === "--")
    throw new GateAdmissionError("invalid_manual_gate_arguments");
  const values = new Map();
  for (let index = 0; index < normalized.length; index += 2) {
    const name = normalized[index];
    const value = normalized[index + 1];
    if (
      typeof name !== "string" ||
      !/^--[a-z][a-z0-9-]*$/u.test(name) ||
      typeof value !== "string" ||
      values.has(name)
    )
      throw new GateAdmissionError("invalid_manual_gate_arguments");
    values.set(name, value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined || value.length === 0)
    throw new GateAdmissionError(
      `missing_${name.slice(2).replaceAll("-", "_")}`,
    );
  return value;
}

export function parseManualGateArguments(argv, environment) {
  const values = exactOptions(argv);
  const allowed = new Set([
    "--attestation",
    "--aws-executable",
    "--azurite-image",
    "--docker-executable",
    "--evidence-path",
    "--hq-archive",
    "--hq-binary",
    "--id-executable",
    "--io-device",
    "--object-client-image",
    "--object-image",
    "--operation",
    "--node-executable",
    "--postgres-image",
    "--psql-executable",
    "--project-quota-helper",
    "--review-manifest",
    "--review-manifest-sha256",
    "--run-id",
    "--sandbox-root",
    "--systemctl-executable",
    "--systemd-analyze-executable",
    "--systemd-run-executable",
  ]);
  if ([...values.keys()].some((name) => !allowed.has(name)))
    throw new GateAdmissionError("unknown_manual_gate_argument");
  const attestation = required(values, "--attestation");
  if (
    attestation !== DISPOSABLE_HOST_ATTESTATION ||
    environment.WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION !== attestation
  )
    throw new GateAdmissionError("disposable_host_attestation_missing");
  const runId = required(values, "--run-id");
  if (!OWNED_NAME_PATTERN.test(runId))
    throw new GateAdmissionError("unsafe_production_gate_run_id");
  const operation = required(values, "--operation");
  if (operation !== "run" && operation !== "recover-cleanup")
    throw new GateAdmissionError("manual_gate_operation_invalid");
  const sandboxRoot = required(values, "--sandbox-root");
  const expectedSandboxRoot = `${GATE_SANDBOX_PARENT}/${runId}`;
  if (
    !isAbsolute(sandboxRoot) ||
    resolve(sandboxRoot) !== sandboxRoot ||
    basename(sandboxRoot) !== runId ||
    sandboxRoot !== expectedSandboxRoot
  )
    throw new GateAdmissionError("unsafe_production_gate_sandbox_root");
  const absoluteOption = (name) => {
    const value = required(values, name);
    if (!isAbsolute(value) || value.includes("\u0000"))
      throw new GateAdmissionError(
        `unsafe_${name.slice(2).replaceAll("-", "_")}`,
      );
    return value;
  };
  const evidencePath = absoluteOption("--evidence-path");
  if (evidencePath !== `${sandboxRoot}/evidence.json`)
    throw new GateAdmissionError("evidence_path_must_be_in_owned_sandbox");
  const ioDevice = absoluteOption("--io-device");
  if (!/^\/dev\/[A-Za-z0-9._-]+$/u.test(ioDevice))
    throw new GateAdmissionError("unsafe_io_device");
  const reviewManifestSha256 = required(values, "--review-manifest-sha256");
  if (
    !/^[a-f0-9]{64}$/u.test(reviewManifestSha256) ||
    environment.WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256 !==
      reviewManifestSha256
  )
    throw new GateAdmissionError("review_manifest_attestation_missing");
  return Object.freeze({
    attestation,
    awsExecutable: absoluteOption("--aws-executable"),
    azuriteImage: required(values, "--azurite-image"),
    dockerExecutable: absoluteOption("--docker-executable"),
    evidencePath,
    hqArchive: absoluteOption("--hq-archive"),
    hqBinary: absoluteOption("--hq-binary"),
    idExecutable: absoluteOption("--id-executable"),
    ioDevice,
    nodeExecutable: absoluteOption("--node-executable"),
    objectClientImage: required(values, "--object-client-image"),
    objectImage: required(values, "--object-image"),
    operation,
    postgresImage: required(values, "--postgres-image"),
    psqlExecutable: absoluteOption("--psql-executable"),
    projectQuotaHelper: absoluteOption("--project-quota-helper"),
    reviewManifest: absoluteOption("--review-manifest"),
    reviewManifestSha256,
    runId,
    sandboxRoot,
    systemctlExecutable: absoluteOption("--systemctl-executable"),
    systemdAnalyzeExecutable: absoluteOption("--systemd-analyze-executable"),
    systemdRunExecutable: absoluteOption("--systemd-run-executable"),
  });
}

export function validatePinnedImages(config) {
  if (config.azuriteImage !== AZURITE_FIXTURE_IMAGE)
    throw new GateAdmissionError("azurite_fixture_image_not_digest_pinned");
  if (config.postgresImage !== POSTGRES_FIXTURE_IMAGE)
    throw new GateAdmissionError("postgres_image_not_18_4_digest_pinned");
  if (config.objectImage !== OBJECT_FIXTURE_IMAGE)
    throw new GateAdmissionError("object_fixture_image_not_digest_pinned");
  const sha = "[a-f0-9]{64}";
  if (
    !new RegExp(
      `^(?:quay\\.io/)?minio/mc:RELEASE\\.[A-Za-z0-9._-]+@sha256:${sha}$`,
      "u",
    ).test(config.objectClientImage)
  )
    throw new GateAdmissionError("object_client_image_not_digest_pinned");
}

export async function createOwnedSandbox(config) {
  const parent = dirname(config.sandboxRoot);
  if (parent !== GATE_SANDBOX_PARENT)
    throw new GateAdmissionError("sandbox_parent_not_gate_owned");
  const canonicalParent = await realpath(parent);
  const parentIdentity = await lstat(parent);
  if (
    canonicalParent !== parent ||
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    parentIdentity.uid !== 0 ||
    parentIdentity.gid !== 0 ||
    (parentIdentity.mode & 0o022) !== 0
  )
    throw new GateAdmissionError("sandbox_parent_is_not_canonical");
  try {
    await lstat(config.sandboxRoot);
    throw new GateAdmissionError("sandbox_root_already_exists");
  } catch (error) {
    if (error instanceof GateAdmissionError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(config.sandboxRoot, { mode: 0o700 });
  try {
    const identity = await lstat(config.sandboxRoot);
    if (
      !identity.isDirectory() ||
      identity.isSymbolicLink() ||
      (identity.mode & 0o7777) !== 0o700 ||
      identity.uid !== 0 ||
      identity.gid !== 0
    )
      throw new GateAdmissionError("sandbox_root_ownership_unproven");
  } catch (error) {
    await rm(config.sandboxRoot, { force: true, recursive: true });
    throw error;
  }
  return config.sandboxRoot;
}

export async function assertOwnedSandbox(config) {
  if (dirname(config.sandboxRoot) !== GATE_SANDBOX_PARENT)
    throw new GateAdmissionError("sandbox_parent_not_gate_owned");
  const canonicalParent = await realpath(GATE_SANDBOX_PARENT);
  const canonicalRoot = await realpath(config.sandboxRoot);
  const parentIdentity = await lstat(GATE_SANDBOX_PARENT);
  const identity = await lstat(config.sandboxRoot);
  if (
    canonicalParent !== GATE_SANDBOX_PARENT ||
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    parentIdentity.uid !== 0 ||
    parentIdentity.gid !== 0 ||
    (parentIdentity.mode & 0o022) !== 0 ||
    canonicalRoot !== config.sandboxRoot ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    (identity.mode & 0o7777) !== 0o700 ||
    identity.uid !== 0 ||
    identity.gid !== 0
  )
    throw new GateAdmissionError("sandbox_root_ownership_unproven");
  return config.sandboxRoot;
}

function exactObject(value, keys, code) {
  const expected = new Set(keys);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  )
    throw new GateAdmissionError(code);
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const excludedRepositoryEntries = new Set([
  ".agents",
  ".codex",
  ".git",
  ".pnpm-store",
  ".tmp",
  "coverage",
  "node_modules",
]);

async function exactRepositoryInventory(root = repositoryRoot) {
  const files = [];
  const visit = async (directory) => {
    const directoryIdentity = await lstat(directory);
    if (
      (await realpath(directory)) !== directory ||
      !directoryIdentity.isDirectory() ||
      directoryIdentity.isSymbolicLink() ||
      directoryIdentity.uid !== 0 ||
      directoryIdentity.gid !== 0 ||
      (directoryIdentity.mode & 0o022) !== 0
    )
      throw new GateAdmissionError("reviewed_repository_directory_untrusted");
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (excludedRepositoryEntries.has(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      const identity = await lstat(path);
      if (identity.isSymbolicLink())
        throw new GateAdmissionError("reviewed_repository_symlink_refused");
      if (identity.isDirectory()) await visit(path);
      else if (identity.isFile()) files.push(path);
      else throw new GateAdmissionError("reviewed_repository_entry_invalid");
    }
  };
  await visit(root);
  return files;
}

async function verifyRuntimeModuleLinks(reviewedPathSet) {
  const requirements = Object.freeze([
    Object.freeze({
      link: `${repositoryRoot}/node_modules/@workload-funnel/executor-systemd`,
      target: `${repositoryRoot}/packages/executor-systemd`,
    }),
    Object.freeze({
      link: `${repositoryRoot}/packages/executor-systemd/node_modules/@workload-funnel/node-execution`,
      target: `${repositoryRoot}/packages/node-execution`,
    }),
  ]);
  const entrypoints = Object.freeze([
    `${repositoryRoot}/packages/executor-systemd/dist/features/capability-discovery/index.js`,
    `${repositoryRoot}/packages/executor-systemd/dist/features/cgroup-resource-mapping/index.js`,
    `${repositoryRoot}/packages/node-execution/dist/features/resource-enforcement/index.js`,
  ]);
  if (entrypoints.some((path) => !reviewedPathSet.has(path)))
    throw new GateAdmissionError("reviewed_runtime_module_missing");
  for (const requirement of requirements) {
    for (const directory of [
      dirname(requirement.link),
      dirname(dirname(requirement.link)),
    ]) {
      const identity = await lstat(directory);
      if (
        (await realpath(directory)) !== directory ||
        !identity.isDirectory() ||
        identity.isSymbolicLink() ||
        identity.uid !== 0 ||
        identity.gid !== 0 ||
        (identity.mode & 0o022) !== 0
      )
        throw new GateAdmissionError("runtime_module_resolution_untrusted");
    }
    const identity = await lstat(requirement.link);
    if (
      !identity.isSymbolicLink() ||
      identity.uid !== 0 ||
      identity.gid !== 0 ||
      (await realpath(requirement.link)) !== requirement.target
    )
      throw new GateAdmissionError("runtime_module_resolution_untrusted");
  }
  return Object.freeze(
    requirements.map((requirement) => Object.freeze({ ...requirement })),
  );
}

export async function verifyReviewedHostInputs(config) {
  const canonicalManifest = await realpath(config.reviewManifest);
  if (canonicalManifest !== config.reviewManifest)
    throw new GateAdmissionError("review_manifest_path_not_canonical");
  const manifestIdentity = await lstat(config.reviewManifest);
  if (
    !manifestIdentity.isFile() ||
    manifestIdentity.isSymbolicLink() ||
    manifestIdentity.uid !== 0 ||
    manifestIdentity.gid !== 0 ||
    (manifestIdentity.mode & 0o022) !== 0 ||
    manifestIdentity.size < 1 ||
    manifestIdentity.size > 1024 * 1024
  )
    throw new GateAdmissionError("review_manifest_identity_untrusted");
  const bytes = await readFile(config.reviewManifest);
  if (digest(bytes) !== config.reviewManifestSha256)
    throw new GateAdmissionError("review_manifest_digest_mismatch");
  let decoded;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new GateAdmissionError("review_manifest_malformed");
  }
  const manifest = exactObject(
    decoded,
    [
      "executables",
      "host",
      "images",
      "reviewId",
      "reviewedFiles",
      "schemaVersion",
      "sourceTreeDigest",
    ],
    "review_manifest_schema_invalid",
  );
  if (
    manifest.schemaVersion !== REVIEW_MANIFEST_SCHEMA ||
    typeof manifest.reviewId !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/u.test(manifest.reviewId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(manifest.sourceTreeDigest ?? "") ||
    !Array.isArray(manifest.reviewedFiles) ||
    manifest.reviewedFiles.length < 1
  )
    throw new GateAdmissionError("review_manifest_schema_invalid");
  const expectedHost = exactObject(
    manifest.host,
    ["architecture", "bootIdSha256", "kernelRelease", "machineIdSha256"],
    "review_manifest_host_invalid",
  );
  const [bootId, machineId] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/etc/machine-id", "utf8"),
  ]);
  const observedHost = Object.freeze({
    architecture: arch(),
    bootIdSha256: digest(Buffer.from(bootId.trim(), "utf8")),
    kernelRelease: release(),
    machineIdSha256: digest(Buffer.from(machineId.trim(), "utf8")),
  });
  if (
    observedHost.architecture !== "x64" ||
    expectedHost.architecture !== observedHost.architecture ||
    expectedHost.kernelRelease !== observedHost.kernelRelease ||
    expectedHost.bootIdSha256 !== observedHost.bootIdSha256 ||
    expectedHost.machineIdSha256 !== observedHost.machineIdSha256
  )
    throw new GateAdmissionError("review_manifest_host_identity_mismatch");
  const expectedExecutablePaths = [
    config.awsExecutable,
    config.dockerExecutable,
    config.hqBinary,
    config.idExecutable,
    config.nodeExecutable,
    config.psqlExecutable,
    config.projectQuotaHelper,
    config.systemctlExecutable,
    config.systemdAnalyzeExecutable,
    config.systemdRunExecutable,
  ].sort();
  if (
    !Array.isArray(manifest.executables) ||
    manifest.executables
      .map((item) => item?.path)
      .sort()
      .join("\n") !== expectedExecutablePaths.join("\n")
  )
    throw new GateAdmissionError(
      "review_manifest_executable_inventory_invalid",
    );
  const identities = [];
  for (const expected of manifest.executables) {
    exactObject(
      expected,
      ["gid", "mode", "path", "sha256", "uid"],
      "review_manifest_executable_invalid",
    );
    const observed = await inspectCanonicalExecutable(expected.path);
    if (
      expected.uid !== 0 ||
      expected.gid !== 0 ||
      expected.uid !== observed.uid ||
      expected.gid !== observed.gid ||
      expected.mode !== observed.mode ||
      expected.sha256 !== observed.sha256
    )
      throw new GateAdmissionError("reviewed_executable_identity_mismatch");
    identities.push(observed);
  }
  if (
    [config.hqBinary, config.nodeExecutable].some(
      (path) =>
        (identities.find((identity) => identity.path === path).mode & 0o001) ===
        0,
    )
  )
    throw new GateAdmissionError("reviewed_workload_executable_not_nonroot");
  const images = exactObject(
    manifest.images,
    ["azuriteFixture", "objectClient", "objectFixture", "postgresFixture"],
    "review_manifest_image_inventory_invalid",
  );
  if (
    images.azuriteFixture !== config.azuriteImage ||
    images.postgresFixture !== config.postgresImage ||
    images.objectFixture !== config.objectImage ||
    images.objectClient !== config.objectClientImage
  )
    throw new GateAdmissionError("reviewed_image_identity_mismatch");
  const reviewedFiles = [];
  for (const item of manifest.reviewedFiles) {
    exactObject(item, ["path", "sha256"], "review_manifest_file_invalid");
    if (
      typeof item.path !== "string" ||
      !isAbsolute(item.path) ||
      resolve(item.path) !== item.path ||
      !/^[a-f0-9]{64}$/u.test(item.sha256)
    )
      throw new GateAdmissionError("review_manifest_file_invalid");
    const canonical = await realpath(item.path);
    const identity = await lstat(item.path);
    const fileBytes = await readFile(item.path);
    if (
      canonical !== item.path ||
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      identity.uid !== 0 ||
      identity.gid !== 0 ||
      (identity.mode & 0o022) !== 0 ||
      digest(fileBytes) !== item.sha256
    )
      throw new GateAdmissionError("reviewed_file_identity_mismatch");
    reviewedFiles.push(Object.freeze({ path: item.path, sha256: item.sha256 }));
  }
  const expectedReviewedPaths = [
    ...(await exactRepositoryInventory()),
    config.hqArchive,
  ];
  const expectedPathSet = new Set(expectedReviewedPaths);
  const actualPathSet = new Set(reviewedFiles.map((item) => item.path));
  if (
    actualPathSet.size !== reviewedFiles.length ||
    actualPathSet.size !== expectedPathSet.size ||
    [...expectedPathSet].some((path) => !actualPathSet.has(path))
  )
    throw new GateAdmissionError("review_manifest_file_inventory_invalid");
  const runtimeModuleLinks = await verifyRuntimeModuleLinks(actualPathSet);
  const architecturePath = `${repositoryRoot}/docs/workload-funnel-architecture-plan.md`;
  if (
    reviewedFiles.find((item) => item.path === architecturePath)?.sha256 !==
    ARCHITECTURE_PLAN_SHA256
  )
    throw new GateAdmissionError("architecture_plan_digest_mismatch");
  const sourceTreeDigest = `sha256:${digest(
    Buffer.from(
      reviewedFiles
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((item) => `${item.path}\0${item.sha256}\n`)
        .join(""),
      "utf8",
    ),
  )}`;
  if (sourceTreeDigest !== manifest.sourceTreeDigest)
    throw new GateAdmissionError("reviewed_source_tree_digest_mismatch");
  const executableSet = new ReviewedExecutableSet(identities);
  return Object.freeze({
    executableSet,
    evidence: Object.freeze({
      architecturePlanSha256: ARCHITECTURE_PLAN_SHA256,
      executables: executableSet.evidence(),
      host: observedHost,
      images: Object.freeze({ ...images }),
      manifestSha256: config.reviewManifestSha256,
      reviewId: manifest.reviewId,
      reviewedFileCount: reviewedFiles.length,
      runtimeModuleLinks,
      sourceTreeDigest,
    }),
  });
}
