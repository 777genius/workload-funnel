import { Buffer } from "node:buffer";

import {
  ARCHITECTURE_PLAN_SHA256,
  AWS_CLI,
  HOST_MINIMUMS,
  PINNED_IMAGES,
  POSTGRES_CLIENT,
  POSTGRES_SIGNING_KEY,
  PRODUCTION_GATE_RECOVERY_SCHEMA,
  PRODUCTION_GATE_SCHEMA,
  REQUIRED_BOOTSTRAP_TOOLS,
  REQUIRED_PRODUCTION_COMPONENTS,
  REVIEW_MANIFEST_SCHEMA,
  RUNTIME_PACKAGE_NAMES,
} from "./constants.mjs";
import { sha256 } from "./contract.mjs";
import { postgresAptConfiguration } from "./host-tools.mjs";
import { sourceTreeDigest } from "./review-manifest.mjs";

export function environment(overrides = {}) {
  return {
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_RUN_ID: "123456789",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKSPACE: "/home/runner/work/workload-funnel/workload-funnel",
    RUNNER_TEMP: "/home/runner/work/_temp",
    ...overrides,
  };
}

export function identity(path) {
  return Object.freeze({
    ancestors: Object.freeze([
      Object.freeze({
        gid: 0,
        kind: "directory",
        mode: 0o755,
        symlink: false,
        uid: 0,
      }),
    ]),
    canonicalPath: path,
    gid: 0,
    kind: "file",
    mode: 0o755,
    path,
    sha256: "b".repeat(64),
    symlink: false,
    uid: 0,
  });
}

export function admittedObservation() {
  return {
    cgroup: {
      controllers: ["cpu", "io", "memory", "pids"],
      filesystem: "cgroup2",
    },
    docker: {
      containers: [],
      images: [],
      nonDefaultNetworks: [],
      pinnedReferenceCollisions: [],
      serverVersion: "29.1.3",
      volumes: [],
    },
    foreign: {
      paths: [],
      processes: [],
      syntheticGroupExists: false,
      syntheticUserExists: false,
    },
    pid1: "systemd",
    resources: {
      cpuCount: HOST_MINIMUMS.cpuCount,
      cpuPsiSome: 0,
      diskAvailableBytes: HOST_MINIMUMS.diskAvailableBytes,
      diskAvailableRatio: HOST_MINIMUMS.diskAvailableRatio,
      inodeAvailableRatio: HOST_MINIMUMS.inodeAvailableRatio,
      ioPsiSome: 0,
      loadPerCpu: 0,
      memoryAvailableBytes: HOST_MINIMUMS.memoryAvailableBytes,
      memoryAvailableRatio: HOST_MINIMUMS.memoryAvailableRatio,
      memoryPsiSome: 0,
      memoryTotalBytes: HOST_MINIMUMS.memoryTotalBytes,
      pidHeadroom: HOST_MINIMUMS.pidHeadroom,
    },
    rootSudo: { effectiveUid: 0, sudoUid: 1001 },
    systemd: { foreignUnits: [], version: 255 },
    tools: Object.fromEntries(
      REQUIRED_BOOTSTRAP_TOOLS.map((name) => [
        name,
        identity(`/usr/bin/${name}`),
      ]),
    ),
  };
}

export function passingProductionEvidence(runId) {
  const unsigned = {
    components: REQUIRED_PRODUCTION_COMPONENTS.map((id) => ({
      evidence: [
        { detail: {}, id: `${id}_real_evidence`, passed: true, source: "real" },
      ],
      id,
      reasonCode: null,
      status: "PASS",
    })),
    finishedAt: "2026-07-18T12:01:00.000Z",
    host: {
      architecture: "x64",
      bootIdSha256: "a".repeat(64),
      hostname: "github-runner",
      kernelRelease: "6.11.0-hosted",
      machineIdSha256: "b".repeat(64),
      reviewManifestSha256: "c".repeat(64),
      sourceTreeDigest: `sha256:${"d".repeat(64)}`,
    },
    overallVerdict: "PASS",
    privilegedStartsEnabled: false,
    productionStartsEnabled: false,
    runId,
    schemaVersion: PRODUCTION_GATE_SCHEMA,
    startedAt: "2026-07-18T12:00:00.000Z",
    syntheticEvidenceAcceptedForRealFields: false,
  };
  return {
    ...unsigned,
    evidenceDigest: `sha256:${sha256(Buffer.from(JSON.stringify(unsigned)))}`,
  };
}

function exactReviewTuple(evidence) {
  return {
    architecturePlanSha256: ARCHITECTURE_PLAN_SHA256,
    executables: [{ path: "/opt/reviewed/node" }],
    host: {
      architecture: evidence.host.architecture,
      bootIdSha256: evidence.host.bootIdSha256,
      kernelRelease: evidence.host.kernelRelease,
      machineIdSha256: evidence.host.machineIdSha256,
    },
    images: PINNED_IMAGES,
    manifestSha256: evidence.host.reviewManifestSha256,
    reviewId: "github:review",
    reviewedFileCount: 42,
    runtimeModuleLinks: [
      { link: "/review/node_modules/executor", target: "/review/executor" },
      { link: "/review/node_modules/node", target: "/review/node" },
    ],
    sourceTreeDigest: evidence.host.sourceTreeDigest,
  };
}

export function certainRecovery(evidence) {
  return {
    cleanup: { certain: true, outcomes: [], pending: [] },
    host: evidence.host,
    review: exactReviewTuple(evidence),
    runId: evidence.runId,
    schemaVersion: PRODUCTION_GATE_RECOVERY_SCHEMA,
  };
}

export function exactPrepareFixture(context) {
  const hostRoot = context.hostRoot;
  const reviewRoot = `${hostRoot}/source`;
  const awsPath = `${hostRoot}/aws-cli/aws`;
  const psqlPath = "/usr/lib/postgresql/18/bin/psql";
  const postgresApt = postgresAptConfiguration(hostRoot);
  const reviewedDownloads = [
    "hq-v0.26.2-linux-x64.tar.gz",
    "ACCC4CF8.asc",
    "postgresql-pgdg.list",
    "aws-cli-signing-key.asc",
    `${AWS_CLI.archiveName}.sig`,
    AWS_CLI.archiveName,
  ].map((name) => `${reviewRoot}/reviewed-host-downloads/${name}`);
  const runtimeCustody = RUNTIME_PACKAGE_NAMES.map((name, index) => ({
    external: name === "@azure/storage-blob",
    name,
    target:
      name === "@azure/storage-blob"
        ? `${reviewRoot}/node_modules/.reviewed-runtime/azure-storage-blob`
        : `${reviewRoot}/packages/internal-${index}`,
    version: name === "@azure/storage-blob" ? "12.33.0" : "0.1.0",
  }));
  const reviewedFiles = [
    ...reviewedDownloads.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64),
    })),
    {
      path: `${reviewRoot}/reviewed-runtime-packages.tar`,
      sha256: "f".repeat(64),
    },
    {
      path: `${reviewRoot}/reviewed-runtime-integrity.json`,
      sha256: "9".repeat(64),
    },
  ];
  reviewedFiles[0].sha256 =
    "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5";
  reviewedFiles[2].sha256 = sha256(
    Buffer.from(`${postgresApt.aptSource}\n`, "utf8"),
  );
  reviewedFiles[5].sha256 = AWS_CLI.archiveSha256;
  const manifest = {
    executables: [
      { gid: 0, mode: 0o555, path: awsPath, sha256: "a".repeat(64), uid: 0 },
      { gid: 0, mode: 0o555, path: psqlPath, sha256: "b".repeat(64), uid: 0 },
    ],
    host: {},
    images: PINNED_IMAGES,
    reviewId: "github:review",
    reviewedFiles,
    schemaVersion: REVIEW_MANIFEST_SCHEMA,
    sourceTreeDigest: sourceTreeDigest(reviewedFiles),
  };
  const prepare = {
    build: { commit: "a".repeat(40), reviewRoot },
    downloads: {
      awsCli: {
        archiveSha256: AWS_CLI.archiveSha256,
        archiveUrl: AWS_CLI.archiveUrl,
        binaryPath: awsPath,
        binarySha256: "a".repeat(64),
        runnerPreinstallAccepted: false,
        signatureUrl: AWS_CLI.signatureUrl,
        signerFingerprint: AWS_CLI.signingKeyFingerprint,
        version: AWS_CLI.version,
      },
      hyperqueueArchiveSha256:
        "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5",
      hyperqueueVersion: "0.26.2",
      postgresClient: {
        aptIsolation: {
          archivesPath: postgresApt.archivesPath,
          listsPath: postgresApt.listsPath,
          sourceListPath: postgresApt.sourceListPath,
        },
        aptSource: postgresApt.aptSource,
        binaryPath: psqlPath,
        binarySha256: "b".repeat(64),
        officialRepositoryKeyFingerprint: POSTGRES_SIGNING_KEY.fingerprint,
        packageName: POSTGRES_CLIENT.packageName,
        packageVersion: POSTGRES_CLIENT.packageVersion,
        preinstalled: false,
        psqlVersion: POSTGRES_CLIENT.psqlVersion,
      },
      reviewedDownloads,
    },
    hostBootstrap: {
      filesystem: "xfs",
      loopDevice: "/dev/loop9",
      mountOptions: ["nodev", "nosuid", "prjquota"],
      packageChanges: {
        changed: [],
        installed: [
          {
            name: POSTGRES_CLIENT.packageName,
            version: POSTGRES_CLIENT.packageVersion,
          },
        ],
        removed: [],
      },
      privateRootModes: { allocations: 0o700, projectQuota: 0o700 },
      syntheticUser: "workload-funnel-synthetic",
    },
    images: PINNED_IMAGES,
    prepared: true,
    preparedAt: "2026-07-18T12:00:00.000Z",
    reviewManifestSha256: "c".repeat(64),
    runId: context.runId,
    runtimeBundle: {
      packageCount: 1,
      path: `${reviewRoot}/reviewed-runtime-packages.tar`,
      sha256: "f".repeat(64),
    },
    runtimeCustody,
    runtimeIntegrity: {
      fileCount: 2,
      linkCount: 2,
      path: `${reviewRoot}/reviewed-runtime-integrity.json`,
      sha256: "9".repeat(64),
    },
    schemaVersion: "workload-funnel.hosted-production-gate.v1",
  };
  return { manifest, prepare };
}
