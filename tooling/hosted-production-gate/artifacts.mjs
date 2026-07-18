import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  AWS_CLI,
  HOSTED_GATE_SCHEMA,
  HOSTED_VERDICT_SCHEMA,
  HYPERQUEUE,
  PINNED_IMAGES,
  POSTGRES_CLIENT,
  POSTGRES_SIGNING_KEY,
  REVIEW_MANIFEST_SCHEMA,
  RUNTIME_PACKAGE_NAMES,
} from "./constants.mjs";
import { HostedGateRefusal, sha256 } from "./contract.mjs";
import { postgresAptConfiguration } from "./host-tools.mjs";
import { validateProductionEvidence } from "./production-evidence.mjs";
import { validateRecoveryDocuments } from "./recovery-evidence.mjs";
import { validateResidue } from "./residue.mjs";
import {
  sha256Sums,
  sourceTreeDigest,
  writeJsonAtomically,
} from "./review-manifest.mjs";

export { validateProductionEvidence } from "./production-evidence.mjs";
export { validateRecoveryDocuments } from "./recovery-evidence.mjs";
export { validateResidue, verifyZeroResidue } from "./residue.mjs";

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export const REQUIRED_OUTPUTS = Object.freeze([
  "cleanup-1.json",
  "cleanup-1.log",
  "cleanup-1-status.json",
  "cleanup-2.json",
  "cleanup-2.log",
  "cleanup-2-status.json",
  "context.json",
  "evidence.json",
  "gate.log",
  "gate-status.json",
  "host-cleanup.json",
  "hosted-verdict.json",
  "host-state-evidence.json",
  "prepare.json",
  "preflight.json",
  "residue.json",
  "review-manifest.json",
  "workflow-status.json",
]);

async function ensureOutput(context, name) {
  const path = `${context.artifactRoot}/${name}`;
  if (await exists(path)) return;
  if (name.endsWith(".log")) {
    await writeFile(path, `required output ${name} was not produced\n`, {
      flag: "wx",
      mode: 0o444,
    });
    return;
  }
  await writeJsonAtomically(path, {
    available: false,
    reason: "required_output_missing",
    requiredOutput: name,
    runId: context.runId,
    schemaVersion: HOSTED_GATE_SCHEMA,
  });
}

export async function packageArtifacts(context) {
  for (const name of REQUIRED_OUTPUTS)
    if (name !== "hosted-verdict.json") await ensureOutput(context, name);
  await writeJsonAtomically(
    `${context.artifactRoot}/hosted-verdict.json`,
    await determineHostedVerdict(context),
    0o444,
  );
  const entries = [];
  for (const entry of await readdir(context.artifactRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === "SHA256SUMS") continue;
    const path = `${context.artifactRoot}/${entry.name}`;
    const identity = await lstat(path);
    if (
      !entry.isFile() ||
      identity.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      identity.size > 64 * 1024 * 1024
    )
      throw new HostedGateRefusal("artifact_entry_untrusted");
    entries.push({ name: entry.name, sha256: sha256(await readFile(path)) });
    await chmod(path, 0o444);
  }
  const sums = sha256Sums(entries);
  await writeFile(`${context.artifactRoot}/SHA256SUMS`, sums, {
    flag: "wx",
    mode: 0o444,
  });
  await chmod(context.artifactRoot, 0o555);
  return Object.freeze(entries);
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

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

const WORKFLOW_PHASES = Object.freeze([
  ["initialization", "initialize"],
  ["checkout", "checkout"],
  ["context", "context"],
  ["commit", "commit-binding"],
  ["node", "node-setup"],
  ["install", "dependency-install"],
  ["build", "build"],
  ["prepare", "host-prepare"],
  ["gate", "production-gate"],
  ["cleanupFirst", "cleanup-1"],
  ["cleanupSecond", "cleanup-2"],
  ["teardown", "host-teardown"],
  ["residue", "residue"],
]);

function validateWorkflowStatus(status) {
  exactObject(
    status,
    WORKFLOW_PHASES.map(([field]) => field),
    "workflow_status_invalid",
  );
  for (const [field] of WORKFLOW_PHASES)
    refuse(
      !new Set(["cancelled", "failure", "skipped", "success"]).has(
        status[field],
      ),
      "workflow_status_invalid",
    );
  return status;
}

function boundedReason(error) {
  return error instanceof Error && /^[a-z0-9_:-]{1,160}$/u.test(error.message)
    ? error.message
    : "hosted_success_evidence_invalid";
}

function hostedVerdict(context, overallVerdict, blockedPhase, reason) {
  return Object.freeze({
    blockedPhase,
    commit: context.commit,
    overallVerdict,
    reason,
    runAttempt: context.runAttempt,
    runId: context.runNumber,
    schemaVersion: HOSTED_VERDICT_SCHEMA,
  });
}

export function validateHostedVerdict(verdict, context) {
  exactObject(
    verdict,
    [
      "blockedPhase",
      "commit",
      "overallVerdict",
      "reason",
      "runAttempt",
      "runId",
      "schemaVersion",
    ],
    "hosted_verdict_invalid",
  );
  refuse(
    verdict.schemaVersion !== HOSTED_VERDICT_SCHEMA ||
      verdict.commit !== context.commit ||
      verdict.runId !== context.runNumber ||
      verdict.runAttempt !== context.runAttempt ||
      !new Set(["BLOCKED", "PASS"]).has(verdict.overallVerdict) ||
      (verdict.overallVerdict === "PASS" &&
        (verdict.blockedPhase !== null || verdict.reason !== null)) ||
      (verdict.overallVerdict === "BLOCKED" &&
        (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(verdict.blockedPhase ?? "") ||
          !/^[a-z0-9_:-]{1,160}$/u.test(verdict.reason ?? ""))),
    "hosted_verdict_invalid",
  );
  return verdict;
}

export function blockedHostedVerdict(context, status, error) {
  const validated = validateWorkflowStatus(status);
  const failed = WORKFLOW_PHASES.find(
    ([field]) => validated[field] !== "success",
  );
  return hostedVerdict(
    context,
    "BLOCKED",
    failed?.[1] ?? "evidence-validation",
    failed === undefined
      ? boundedReason(error)
      : `${failed[1].replaceAll("-", "_")}_failed_closed`,
  );
}

async function determineHostedVerdict(context) {
  try {
    await validateSuccessfulOutcome(context);
    return hostedVerdict(context, "PASS", null, null);
  } catch (error) {
    let status;
    try {
      status = validateWorkflowStatus(
        await readJson(
          `${context.artifactRoot}/workflow-status.json`,
          "workflow_status_invalid",
        ),
      );
    } catch {
      return hostedVerdict(
        context,
        "BLOCKED",
        "workflow-status",
        "workflow_status_invalid",
      );
    }
    return blockedHostedVerdict(context, status, error);
  }
}

function validateInvocationStatus(status, invocation, context) {
  exactObject(
    status,
    [
      "exitCode",
      "finishedAt",
      "invocation",
      "operation",
      "reason",
      "runId",
      "schemaVersion",
      "startedAt",
    ],
    "hosted_invocation_status_invalid",
  );
  refuse(
    status.schemaVersion !== HOSTED_GATE_SCHEMA ||
      status.runId !== context.runId ||
      status.invocation !== invocation ||
      status.operation !==
        (invocation === "gate" ? "run" : "recover-cleanup") ||
      status.exitCode !== 0 ||
      status.reason !== null ||
      !validTimestamp(status.startedAt) ||
      !validTimestamp(status.finishedAt) ||
      Date.parse(status.finishedAt) < Date.parse(status.startedAt),
    "hosted_invocation_status_invalid",
  );
}

export function validateHostCleanup(cleanup, context) {
  exactObject(
    cleanup,
    ["certain", "failed", "results", "runId", "schemaVersion"],
    "host_cleanup_evidence_invalid",
  );
  refuse(
    cleanup.schemaVersion !== HOSTED_GATE_SCHEMA ||
      cleanup.runId !== context.runId ||
      cleanup.certain !== true ||
      !Array.isArray(cleanup.failed) ||
      cleanup.failed.length !== 0 ||
      !Array.isArray(cleanup.results) ||
      cleanup.results.length < 1,
    "host_cleanup_evidence_invalid",
  );
  const ids = new Set();
  for (const result of cleanup.results) {
    exactObject(result, ["id", "ok"], "host_cleanup_evidence_invalid");
    refuse(
      typeof result.id !== "string" ||
        result.id.length < 1 ||
        ids.has(result.id) ||
        result.ok !== true,
      "host_cleanup_evidence_invalid",
    );
    ids.add(result.id);
  }
}

export function validatePrepareEvidence(prepare, manifest, context) {
  exactObject(
    prepare,
    [
      "build",
      "downloads",
      "hostBootstrap",
      "images",
      "prepared",
      "preparedAt",
      "reviewManifestSha256",
      "runId",
      "runtimeBundle",
      "runtimeCustody",
      "runtimeIntegrity",
      "schemaVersion",
    ],
    "prepare_evidence_invalid",
  );
  const build = exactObject(
    prepare.build,
    ["commit", "reviewRoot"],
    "prepare_evidence_invalid",
  );
  refuse(
    build.commit !== context.commit ||
      build.reviewRoot !== `${context.hostRoot}/source`,
    "prepare_evidence_invalid",
  );
  refuse(
    prepare.schemaVersion !== HOSTED_GATE_SCHEMA ||
      prepare.runId !== context.runId ||
      prepare.prepared !== true ||
      !validTimestamp(prepare.preparedAt) ||
      !isDeepStrictEqual(prepare.images, PINNED_IMAGES) ||
      !/^[a-f0-9]{64}$/u.test(prepare.reviewManifestSha256 ?? ""),
    "prepare_evidence_invalid",
  );
  const downloads = exactObject(
    prepare.downloads,
    [
      "awsCli",
      "hyperqueueArchiveSha256",
      "hyperqueueVersion",
      "postgresClient",
      "reviewedDownloads",
    ],
    "prepare_download_evidence_invalid",
  );
  const aws = exactObject(
    downloads.awsCli,
    [
      "archiveUrl",
      "archiveSha256",
      "binaryPath",
      "binarySha256",
      "runnerPreinstallAccepted",
      "signatureUrl",
      "signerFingerprint",
      "version",
    ],
    "prepare_download_evidence_invalid",
  );
  const postgres = exactObject(
    downloads.postgresClient,
    [
      "aptIsolation",
      "aptSource",
      "binaryPath",
      "binarySha256",
      "officialRepositoryKeyFingerprint",
      "packageName",
      "packageVersion",
      "preinstalled",
      "psqlVersion",
    ],
    "prepare_download_evidence_invalid",
  );
  const postgresApt = postgresAptConfiguration(
    dirname(prepare.build.reviewRoot),
  );
  const aptIsolation = exactObject(
    postgres.aptIsolation,
    ["archivesPath", "listsPath", "sourceListPath"],
    "prepare_download_evidence_invalid",
  );
  refuse(
    aws?.version !== AWS_CLI.version ||
      aws?.signerFingerprint !== AWS_CLI.signingKeyFingerprint ||
      aws?.archiveUrl !== AWS_CLI.archiveUrl ||
      aws?.archiveSha256 !== AWS_CLI.archiveSha256 ||
      aws?.signatureUrl !== AWS_CLI.signatureUrl ||
      aws?.runnerPreinstallAccepted !== false ||
      !/^[a-f0-9]{64}$/u.test(aws?.binarySha256 ?? "") ||
      typeof aws?.binaryPath !== "string" ||
      postgres?.packageName !== POSTGRES_CLIENT.packageName ||
      postgres?.packageVersion !== POSTGRES_CLIENT.packageVersion ||
      postgres?.psqlVersion !== POSTGRES_CLIENT.psqlVersion ||
      postgres?.officialRepositoryKeyFingerprint !==
        POSTGRES_SIGNING_KEY.fingerprint ||
      postgres?.aptSource !== postgresApt.aptSource ||
      aptIsolation.archivesPath !== postgresApt.archivesPath ||
      aptIsolation.listsPath !== postgresApt.listsPath ||
      aptIsolation.sourceListPath !== postgresApt.sourceListPath ||
      postgres?.preinstalled !== false ||
      !/^[a-f0-9]{64}$/u.test(postgres?.binarySha256 ?? "") ||
      typeof postgres?.binaryPath !== "string" ||
      downloads.hyperqueueVersion !== HYPERQUEUE.version ||
      downloads.hyperqueueArchiveSha256 !== HYPERQUEUE.archiveSha256 ||
      !Array.isArray(downloads.reviewedDownloads) ||
      downloads.reviewedDownloads.length < 6,
    "prepare_download_evidence_invalid",
  );
  exactObject(
    prepare.hostBootstrap,
    [
      "filesystem",
      "loopDevice",
      "mountOptions",
      "packageChanges",
      "privateRootModes",
      "syntheticUser",
    ],
    "prepare_private_root_mode_invalid",
  );
  const packageChanges = exactObject(
    prepare.hostBootstrap.packageChanges,
    ["changed", "installed", "removed"],
    "prepare_package_change_invalid",
  );
  refuse(
    !Array.isArray(packageChanges.changed) ||
      !Array.isArray(packageChanges.installed) ||
      !Array.isArray(packageChanges.removed) ||
      packageChanges.removed.length !== 0 ||
      !packageChanges.installed.some(
        (item) =>
          item?.name === POSTGRES_CLIENT.packageName &&
          item?.version === POSTGRES_CLIENT.packageVersion,
      ),
    "prepare_package_change_invalid",
  );
  refuse(
    prepare.hostBootstrap?.privateRootModes?.allocations !== 0o700 ||
      prepare.hostBootstrap?.privateRootModes?.projectQuota !== 0o700,
    "prepare_private_root_mode_invalid",
  );
  exactObject(
    manifest,
    [
      "executables",
      "host",
      "images",
      "reviewId",
      "reviewedFiles",
      "schemaVersion",
      "sourceTreeDigest",
    ],
    "review_manifest_evidence_invalid",
  );
  refuse(
    manifest.schemaVersion !== REVIEW_MANIFEST_SCHEMA ||
      !isDeepStrictEqual(manifest.images, PINNED_IMAGES) ||
      !/^[A-Za-z0-9._:-]{1,128}$/u.test(manifest.reviewId ?? "") ||
      !Array.isArray(manifest.executables) ||
      manifest.executables.length < 1 ||
      !Array.isArray(manifest.reviewedFiles) ||
      manifest.reviewedFiles.length < 1 ||
      manifest.sourceTreeDigest !== sourceTreeDigest(manifest.reviewedFiles),
    "review_manifest_evidence_invalid",
  );
  const executableMap = new Map(
    manifest.executables.map((entry) => [entry.path, entry]),
  );
  refuse(
    executableMap.get(aws.binaryPath)?.sha256 !== aws.binarySha256 ||
      executableMap.get(postgres.binaryPath)?.sha256 !== postgres.binarySha256,
    "review_manifest_tool_binding_invalid",
  );
  const reviewedPaths = new Set(
    manifest.reviewedFiles.map((item) => item.path),
  );
  refuse(
    downloads.reviewedDownloads.some((path) => !reviewedPaths.has(path)),
    "reviewed_download_custody_incomplete",
  );
  const reviewedDigests = new Map(
    manifest.reviewedFiles.map((item) => [item.path, item.sha256]),
  );
  refuse(
    reviewedDigests.get(
      `${prepare.build.reviewRoot}/reviewed-host-downloads/${AWS_CLI.archiveName}`,
    ) !== aws.archiveSha256 ||
      reviewedDigests.get(
        `${prepare.build.reviewRoot}/reviewed-host-downloads/${HYPERQUEUE.archiveName}`,
      ) !== HYPERQUEUE.archiveSha256 ||
      reviewedDigests.get(
        `${prepare.build.reviewRoot}/reviewed-host-downloads/postgresql-pgdg.list`,
      ) !== sha256(Buffer.from(`${postgresApt.aptSource}\n`, "utf8")),
    "reviewed_download_digest_mismatch",
  );
  const runtimeBundle = exactObject(
    prepare.runtimeBundle,
    ["packageCount", "path", "sha256"],
    "runtime_dependency_bundle_invalid",
  );
  refuse(
    runtimeBundle.path !==
      `${prepare.build.reviewRoot}/reviewed-runtime-packages.tar` ||
      reviewedDigests.get(runtimeBundle.path) !== runtimeBundle.sha256 ||
      !Number.isSafeInteger(runtimeBundle.packageCount) ||
      runtimeBundle.packageCount < 1 ||
      !/^[a-f0-9]{64}$/u.test(runtimeBundle.sha256 ?? ""),
    "runtime_dependency_bundle_invalid",
  );
  refuse(
    !Array.isArray(prepare.runtimeCustody) ||
      RUNTIME_PACKAGE_NAMES.some(
        (name) => !prepare.runtimeCustody.some((item) => item?.name === name),
      ),
    "runtime_dependency_custody_incomplete",
  );
  for (const item of prepare.runtimeCustody) {
    exactObject(
      item,
      ["external", "name", "target", "version"],
      "runtime_dependency_custody_incomplete",
    );
    refuse(
      typeof item.target !== "string" ||
        !item.target.startsWith(`${prepare.build.reviewRoot}/`) ||
        typeof item.version !== "string" ||
        (item.external === true &&
          !item.target.startsWith(
            `${prepare.build.reviewRoot}/node_modules/.reviewed-runtime/`,
          )),
      "runtime_dependency_custody_incomplete",
    );
  }
  refuse(
    prepare.runtimeCustody.filter((item) => item.external === true).length !==
      runtimeBundle.packageCount ||
      prepare.runtimeCustody.find((item) => item.name === "@azure/storage-blob")
        ?.external !== true,
    "runtime_dependency_custody_incomplete",
  );
  const runtimeIntegrity = exactObject(
    prepare.runtimeIntegrity,
    ["fileCount", "linkCount", "path", "sha256"],
    "runtime_custody_integrity_invalid",
  );
  refuse(
    runtimeIntegrity.path !==
      `${prepare.build.reviewRoot}/reviewed-runtime-integrity.json` ||
      reviewedDigests.get(runtimeIntegrity.path) !== runtimeIntegrity.sha256 ||
      !/^[a-f0-9]{64}$/u.test(runtimeIntegrity.sha256 ?? "") ||
      !Number.isSafeInteger(runtimeIntegrity.fileCount) ||
      runtimeIntegrity.fileCount < 1 ||
      !Number.isSafeInteger(runtimeIntegrity.linkCount) ||
      runtimeIntegrity.linkCount < 1,
    "runtime_custody_integrity_invalid",
  );
  return prepare;
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new HostedGateRefusal(code);
  }
}

export async function validateChecksumInventory(context) {
  const sums = await readFile(`${context.artifactRoot}/SHA256SUMS`, "utf8");
  refuse(
    sums.length < 1 || !sums.endsWith("\n"),
    "artifact_checksum_format_invalid",
  );
  const expected = [];
  const names = new Set();
  for (const line of sums.slice(0, -1).split("\n")) {
    const match = line.match(/^([a-f0-9]{64}) {2}([A-Za-z0-9._-]+)$/u);
    refuse(
      match === null || match[2] === "SHA256SUMS" || names.has(match[2]),
      "artifact_checksum_format_invalid",
    );
    names.add(match[2]);
    expected.push({ digest: match[1], name: match[2] });
  }
  const actual = [];
  for (const entry of await readdir(context.artifactRoot, {
    withFileTypes: true,
  })) {
    const path = `${context.artifactRoot}/${entry.name}`;
    const identity = await lstat(path);
    refuse(
      !entry.isFile() ||
        identity.isSymbolicLink() ||
        (identity.mode & 0o222) !== 0 ||
        identity.size < 1,
      "artifact_inventory_untrusted",
    );
    if (entry.name !== "SHA256SUMS") actual.push(entry.name);
  }
  refuse(
    expected.length !== actual.length ||
      actual.some((name) => !names.has(name)) ||
      REQUIRED_OUTPUTS.some((name) => !names.has(name)),
    "artifact_checksum_inventory_incomplete",
  );
  for (const item of expected) {
    const observed = sha256(
      await readFile(`${context.artifactRoot}/${item.name}`),
    );
    refuse(observed !== item.digest, "artifact_checksum_mismatch");
  }
}

async function validateSuccessfulOutcome(context) {
  const contextEvidence = exactObject(
    await readJson(
      `${context.artifactRoot}/context.json`,
      "hosted_context_evidence_invalid",
    ),
    ["commit", "runAttempt", "runId", "runNumber", "schemaVersion"],
    "hosted_context_evidence_invalid",
  );
  refuse(
    contextEvidence.schemaVersion !== HOSTED_GATE_SCHEMA ||
      contextEvidence.commit !== context.commit ||
      contextEvidence.runId !== context.runId ||
      contextEvidence.runNumber !== context.runNumber ||
      contextEvidence.runAttempt !== context.runAttempt,
    "hosted_context_evidence_invalid",
  );
  const workflowStatus = validateWorkflowStatus(
    await readJson(
      `${context.artifactRoot}/workflow-status.json`,
      "workflow_status_invalid",
    ),
  );
  refuse(
    WORKFLOW_PHASES.some(([field]) => workflowStatus[field] !== "success"),
    "workflow_phase_failed",
  );
  const [evidence, prepare, manifest, hostCleanup, residue] = await Promise.all(
    [
      readJson(
        `${context.artifactRoot}/evidence.json`,
        "production_evidence_malformed",
      ),
      readJson(
        `${context.artifactRoot}/prepare.json`,
        "prepare_evidence_malformed",
      ),
      readJson(
        `${context.artifactRoot}/review-manifest.json`,
        "review_manifest_malformed",
      ),
      readJson(
        `${context.artifactRoot}/host-cleanup.json`,
        "host_cleanup_evidence_malformed",
      ),
      readJson(
        `${context.artifactRoot}/residue.json`,
        "residue_evidence_malformed",
      ),
    ],
  );
  validateProductionEvidence(evidence, context);
  refuse(
    sha256(await readFile(`${context.artifactRoot}/review-manifest.json`)) !==
      prepare.reviewManifestSha256,
    "review_manifest_digest_mismatch",
  );
  validatePrepareEvidence(prepare, manifest, context);
  refuse(
    evidence.host.reviewManifestSha256 !== prepare.reviewManifestSha256 ||
      evidence.host.sourceTreeDigest !== manifest.sourceTreeDigest,
    "production_evidence_review_tuple_mismatch",
  );
  const recoveries = await Promise.all(
    ["cleanup-1.json", "cleanup-2.json"].map((name) =>
      readJson(
        `${context.artifactRoot}/${name}`,
        "cleanup_recovery_evidence_malformed",
      ),
    ),
  );
  validateRecoveryDocuments(recoveries, evidence, context);
  refuse(
    recoveries[0].review.reviewId !== manifest.reviewId ||
      recoveries[0].review.reviewedFileCount !==
        manifest.reviewedFiles.length ||
      recoveries[0].review.executables.length !== manifest.executables.length,
    "cleanup_recovery_manifest_tuple_mismatch",
  );
  const invocations = ["gate", "cleanup-1", "cleanup-2"];
  const statuses = await Promise.all(
    invocations.map((name) =>
      readJson(
        `${context.artifactRoot}/${name}-status.json`,
        "hosted_invocation_status_malformed",
      ),
    ),
  );
  for (const [index, status] of statuses.entries())
    validateInvocationStatus(status, invocations[index], context);
  validateHostCleanup(hostCleanup, context);
  validateResidue(residue, context);
}

export async function assertFinalOutcome(context) {
  await validateChecksumInventory(context);
  const verdict = validateHostedVerdict(
    await readJson(
      `${context.artifactRoot}/hosted-verdict.json`,
      "hosted_verdict_malformed",
    ),
    context,
  );
  refuse(verdict.overallVerdict !== "PASS", "hosted_verdict_blocked");
  await validateSuccessfulOutcome(context);
}
