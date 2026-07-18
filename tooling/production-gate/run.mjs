import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, hostname, release } from "node:os";
import { setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

import {
  createOwnedSandbox,
  assertOwnedSandbox,
  GateAdmissionError,
  parseManualGateArguments,
  validatePinnedImages,
  verifyReviewedHostInputs,
} from "./attestation.mjs";
import { runAzureObjectProductionStage } from "./azure-object-stage.mjs";
import {
  cleanupBoundedSystemdUnit,
  createBoundedHostProcessManager,
} from "./bounded-host-process.mjs";
import { BoundedCommandRunner } from "./command-runner.mjs";
import { DECLARED_COMPONENTS } from "./constants.mjs";
import {
  MINIO_SUPERVISOR_DESTINATION,
  objectContainerArguments,
} from "./docker-plan.mjs";
import {
  createDockerRecoveryCleaners,
  GateDockerRuntime,
} from "./docker-runtime.mjs";
import {
  componentResult,
  createRedactor,
  evidenceRecord,
  finalizeEvidence,
} from "./evidence.mjs";
import { writeEvidenceAtomically } from "./evidence-writer.mjs";
import { observeHost } from "./host-observation.mjs";
import { runHyperQueueCompatibilityProbe } from "./hyperqueue-contract.mjs";
import { monotonicMilliseconds } from "./mixed-load.mjs";
import { restartConfinedMinio } from "./minio-process-restart.mjs";
import { bootstrapObjectFixture } from "./object-fixture-bootstrap.mjs";
import { cleanupOwnedDirectoryRecord } from "./owned-directory.mjs";
import {
  providerIdentity,
  runObjectCompatibilityProbe,
} from "./object-contract.mjs";
import { admitPreflight } from "./pressure.mjs";
import { runPressureAdmissionStage } from "./pressure-stage.mjs";
import { runPostgresCompatibilityStage } from "./postgres-stage.mjs";
import { cleanupProjectQuotaRecord } from "./project-quota-runtime.mjs";
import { OwnedResourceLedger } from "./resource-ledger.mjs";
import {
  cleanupSecretFileRecord,
  gateSecret,
  writeSecretFile,
} from "./secret-files.mjs";
import { runSystemdGateProbe } from "./systemd-contract.mjs";
import {
  cleanupSystemdAllocationRecord,
  createSystemdProbeIo,
  prepareSystemdAllocation,
} from "./systemd-runtime.mjs";
import {
  cleanupSystemdSlice,
  createSystemdSliceOwnership,
} from "./systemd-slice-ledger.mjs";
import { probeRealSystemdCapabilities } from "./systemd-capability-probe.mjs";

const startedAt = new Date().toISOString();
const azuriteEntrypointScript = fileURLToPath(
  new URL("./fixtures/azurite-entrypoint.sh", import.meta.url),
);
const minioBootstrapScript = fileURLToPath(
  new URL("./fixtures/minio-bootstrap.sh", import.meta.url),
);
const minioSupervisorScript = fileURLToPath(
  new URL("./fixtures/minio-supervisor.sh", import.meta.url),
);
const systemdFixturePath = fileURLToPath(
  new URL("./fixtures/systemd-workload.mjs", import.meta.url),
);
const hyperQueueGatewayProbeScript = fileURLToPath(
  new URL("./fixtures/hyperqueue-gateway-probe.mjs", import.meta.url),
);
const hyperQueueSyntheticShim = fileURLToPath(
  new URL("./fixtures/hyperqueue-synthetic-shim.mjs", import.meta.url),
);
const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function reasonCode(error) {
  return error instanceof Error && /^[a-z0-9_]{1,128}$/u.test(error.message)
    ? error.message
    : "production_gate_component_failed";
}

function blocked(id, reason, evidence = [], status = "BLOCKED") {
  return componentResult({ evidence, id, reasonCode: reason, status });
}

function passed(id, detail) {
  return componentResult({
    evidence: [evidenceRecord(`${id}_real_evidence`, true, detail)],
    id,
    status: "PASS",
  });
}

async function waitFor(check, code, maximumMs = 30_000) {
  const deadline = Date.now() + maximumMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(code);
    await wait(100);
  }
}

async function observedHostIdentity(reviewEvidence) {
  const [bootId, machineId] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile("/etc/machine-id", "utf8"),
  ]);
  const hash = (value) =>
    createHash("sha256").update(value.trim(), "utf8").digest("hex");
  const observed = Object.freeze({
    architecture: arch(),
    bootIdSha256: hash(bootId),
    hostname: hostname(),
    kernelRelease: release(),
    machineIdSha256: hash(machineId),
    reviewManifestSha256: reviewEvidence.manifestSha256,
    sourceTreeDigest: reviewEvidence.sourceTreeDigest,
  });
  if (
    observed.architecture !== reviewEvidence.host.architecture ||
    observed.kernelRelease !== reviewEvidence.host.kernelRelease ||
    observed.bootIdSha256 !== reviewEvidence.host.bootIdSha256 ||
    observed.machineIdSha256 !== reviewEvidence.host.machineIdSha256
  )
    throw new Error("reviewed_host_identity_changed_during_gate");
  return observed;
}

async function main() {
  let config;
  let reviewed;
  try {
    config = parseManualGateArguments(process.argv.slice(2), process.env);
    validatePinnedImages(config);
    if (process.getuid?.() !== 0)
      throw new GateAdmissionError("production_gate_requires_root_host_runner");
    reviewed = await verifyReviewedHostInputs(config);
    if (config.operation === "run") await createOwnedSandbox(config);
    else await assertOwnedSandbox(config);
  } catch (error) {
    const code =
      error instanceof GateAdmissionError
        ? error.code
        : "manual_gate_admission_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
    return;
  }

  const runner = new BoundedCommandRunner({
    reviewedExecutables: reviewed.executableSet,
  });
  const dockerRecovery = createDockerRecoveryCleaners({
    executable: config.dockerExecutable,
    runId: config.runId,
    runner,
  });
  const systemdCleanupConfig = { ...config, runner };
  const ledger = await OwnedResourceLedger.open({
    path: `${config.sandboxRoot}/cleanup-ledger.json`,
    recoveryCleaners: {
      ...dockerRecovery,
      "secret-file": cleanupSecretFileRecord,
      "owned-directory": cleanupOwnedDirectoryRecord,
      "project-quota": cleanupProjectQuotaRecord,
      "systemd-allocation": cleanupSystemdAllocationRecord,
      "systemd-slice": (record) =>
        cleanupSystemdSlice(systemdCleanupConfig, record),
      "systemd-unit": (record) =>
        cleanupBoundedSystemdUnit(systemdCleanupConfig, record),
    },
    runId: config.runId,
  });
  if (config.operation === "recover-cleanup") {
    const cleanup = await ledger.recover();
    await writeEvidenceAtomically(
      `${config.sandboxRoot}/cleanup-recovery.json`,
      {
        cleanup,
        host: await observedHostIdentity(reviewed.evidence),
        review: reviewed.evidence,
        runId: config.runId,
        schemaVersion: "workload-funnel.production-gate.cleanup-recovery.v1",
      },
    );
    process.stdout.write(`${config.sandboxRoot}/cleanup-recovery.json\n`);
    process.exitCode = cleanup.certain ? 0 : 1;
    return;
  }
  const components = new Map();
  const secrets = [];
  let postgres;
  let docker;
  let systemdEvidence;
  let systemdCapability;
  let systemdCapabilityError;
  let systemdCapabilityEvidence;
  const sliceOwnership = createSystemdSliceOwnership({
    ...config,
    ledger,
    runner,
  });
  let processManager;
  let systemdAllocation;
  const ensureSystemdAllocation = async () => {
    if (systemdAllocation !== undefined) {
      if (systemdCapabilityError !== undefined) throw systemdCapabilityError;
      if (processManager === undefined)
        throw new Error("systemd_capability_preflight_incomplete");
      return systemdAllocation;
    }
    systemdAllocation = await prepareSystemdAllocation({
      ...config,
      ledger,
      runner,
    });
    try {
      const projectQuotaHelper = reviewed.evidence.executables.find(
        (identity) => identity.path === config.projectQuotaHelper,
      );
      if (projectQuotaHelper === undefined)
        throw new Error("project_quota_helper_review_missing");
      systemdCapability = await probeRealSystemdCapabilities({
        ...config,
        ioDevice: config.ioDevice,
        runner,
        ledger,
        projectQuotaHelperSha256: projectQuotaHelper.sha256,
        workloadGroup: systemdAllocation.group,
        workloadRoot: systemdAllocation.root,
        workloadUser: systemdAllocation.user,
      });
      systemdCapabilityEvidence = systemdCapability.evidence;
    } catch (error) {
      systemdCapabilityError = error;
      throw error;
    }
    processManager = createBoundedHostProcessManager({
      ...config,
      allowedExecutables: new Set([config.hqBinary, config.nodeExecutable]),
      ioDevice: config.ioDevice,
      ledger,
      reviewedExecutables: reviewed.executableSet,
      sliceOwnership,
      runner,
      workloadGroup: systemdAllocation.group,
      workloadRoot: systemdAllocation.root,
      workloadUser: systemdAllocation.user,
    });
    return systemdAllocation;
  };
  components.set(
    "attestation",
    passed("attestation", {
      disposableHostAttested: true,
      reviewed: reviewed.evidence,
      rootHostRunner: true,
    }),
  );

  try {
    const observation = await observeHost({ sandboxRoot: config.sandboxRoot });
    const admission = admitPreflight(observation);
    components.set(
      "preflight",
      admission.producerAdmission === "open"
        ? passed("preflight", { admission, observation })
        : blocked("preflight", admission.reason, [
            evidenceRecord("preflight_real_observation", false, {
              admission,
              observation,
            }),
          ]),
    );
  } catch (error) {
    const code = reasonCode(error);
    components.set(
      "preflight",
      blocked(
        "preflight",
        code,
        [],
        code === "host_pressure_interface_unsupported"
          ? "UNSUPPORTED"
          : "BLOCKED",
      ),
    );
  }

  if (components.get("preflight").status === "PASS") {
    docker = new GateDockerRuntime({
      allowedReadOnlyMounts: new Set([
        azuriteEntrypointScript,
        minioBootstrapScript,
        minioSupervisorScript,
      ]),
      executable: config.dockerExecutable,
      ioDevice: config.ioDevice,
      ledger,
      runId: config.runId,
      runner,
      sandboxRoot: config.sandboxRoot,
      secretValues: secrets,
    });
    try {
      const stage = await runPostgresCompatibilityStage({
        config,
        docker,
        ledger,
        runner,
        secrets,
        wait,
        waitFor,
      });
      postgres = stage.connection;
      components.set(
        "postgres_fixture",
        passed("postgres_fixture", stage.evidence),
      );
      components.set(
        "postgres_production_adapter",
        passed("postgres_production_adapter", stage.adapterEvidence),
      );
    } catch (error) {
      components.set(
        "postgres_fixture",
        blocked("postgres_fixture", reasonCode(error)),
      );
      components.set(
        "postgres_production_adapter",
        blocked("postgres_production_adapter", reasonCode(error)),
      );
    }

    try {
      const suffix = config.runId.slice("wf-production-gate-".length);
      const rootAccess = `wfroot${suffix.slice(0, 16)}`;
      const rootSecret = gateSecret();
      secrets.push(rootAccess, rootSecret);
      const rootUserFile = await writeSecretFile({
        contents: `${rootAccess}\n`,
        ledger,
        owner: { gid: 1000, uid: 1000 },
        path: `${config.sandboxRoot}/minio-root-user`,
        runId: config.runId,
        sandboxRoot: config.sandboxRoot,
      });
      const rootPasswordFile = await writeSecretFile({
        contents: `${rootSecret}\n`,
        ledger,
        owner: { gid: 1000, uid: 1000 },
        path: `${config.sandboxRoot}/minio-root-password`,
        runId: config.runId,
        sandboxRoot: config.sandboxRoot,
      });
      const objectName = `${config.runId}-object`;
      const objectIdentity = await docker.startContainer(
        objectName,
        objectContainerArguments({
          image: config.objectImage,
          ioDevice: config.ioDevice,
          name: objectName,
          network: docker.network,
          rootPasswordFile,
          rootUserFile,
          supervisorFile: minioSupervisorScript,
        }),
      );
      const objectSecretMounts = [
        {
          destination: "/run/secrets/minio-root-user",
          source: rootUserFile,
        },
        {
          destination: "/run/secrets/minio-root-password",
          source: rootPasswordFile,
        },
      ];
      const objectProcess = {
        readOnlyMounts: [
          {
            destination: MINIO_SUPERVISOR_DESTINATION,
            source: minioSupervisorScript,
          },
        ],
      };
      const objectDockerConfinement = await docker.inspectContainerConfinement(
        objectName,
        "1000:1000",
        [rootAccess, rootSecret],
        objectIdentity,
        { destination: "/data", kind: "tmpfs" },
        9000,
        config.objectImage,
        objectSecretMounts,
        objectProcess,
      );
      const adminConfigFile = await writeSecretFile({
        contents: `${JSON.stringify({
          aliases: {
            gate: {
              accessKey: rootAccess,
              api: "S3v4",
              path: "auto",
              secretKey: rootSecret,
              url: `http://${objectName}:9000`,
            },
          },
          version: "10",
        })}\n`,
        ledger,
        owner: { gid: 1000, uid: 1000 },
        path: `${config.sandboxRoot}/minio-admin-config.json`,
        runId: config.runId,
        sandboxRoot: config.sandboxRoot,
      });
      const bootstrapScript = minioBootstrapScript;
      const objectReady = async () => {
        try {
          await docker.runClient({
            arguments_: ["/gate/bootstrap.sh", "ready"],
            entrypoint: "/bin/sh",
            image: config.objectClientImage,
            mounts: [
              {
                destination: "/gate/mc/config.json",
                source: adminConfigFile,
              },
              {
                destination: "/gate/bootstrap.sh",
                source: bootstrapScript,
              },
            ],
          });
          return true;
        } catch {
          return false;
        }
      };
      await waitFor(objectReady, "object_fixture_start_timeout");
      const identities = Object.fromEntries(
        ["delete", "upload", "verify"].map((kind) => {
          const identity = {
            access: `wf${kind}${suffix.slice(0, 12)}`,
            secret: gateSecret(),
          };
          secrets.push(identity.secret);
          return [kind, identity];
        }),
      );
      if (
        new Set(Object.values(identities).map((identity) => identity.access))
          .size !== 3
      )
        throw new Error("object_fixture_identity_collision");
      const identityFiles = Object.fromEntries(
        await Promise.all(
          Object.entries(identities).map(async ([kind, identity]) => [
            kind,
            {
              credentialFile: await writeSecretFile({
                contents: `${identity.access}\n${identity.secret}\n`,
                ledger,
                owner: { gid: 1000, uid: 1000 },
                path: `${config.sandboxRoot}/${kind}-identity`,
                runId: config.runId,
                sandboxRoot: config.sandboxRoot,
              }),
              user: identity.access,
            },
          ]),
        ),
      );
      const bucket = `${config.runId}-artifacts`;
      const prefix = `${config.runId}/uploads/`;
      const key = `${prefix}artifact.bin`;
      const bodyPath = `${config.sandboxRoot}/object-body.bin`;
      const body = Buffer.from("workload-funnel production gate object\n");
      await writeFile(bodyPath, body, { flag: "wx", mode: 0o600 });
      const overwriteBodyPath = `${config.sandboxRoot}/object-overwrite.bin`;
      const overwriteBody = Buffer.from("distinct overwrite proof\n", "utf8");
      await writeFile(overwriteBodyPath, overwriteBody, {
        flag: "wx",
        mode: 0o600,
      });
      await bootstrapObjectFixture({
        adminConfigFile,
        bucket,
        bootstrapScript,
        clientImage: config.objectClientImage,
        docker,
        identityFiles,
        key,
        prefix,
        runId: config.runId,
        sandboxRoot: config.sandboxRoot,
      });
      const endpoint = `http://${objectDockerConfinement.internalNetworkEndpoint.ipv4Address}:${String(objectDockerConfinement.internalNetworkEndpoint.port)}`;
      const awsEnvironment = (identity) => ({
        AWS_ACCESS_KEY_ID: identity.access,
        AWS_CONFIG_FILE: "/dev/null",
        AWS_EC2_METADATA_DISABLED: "true",
        AWS_REGION: "us-east-1",
        AWS_SECRET_ACCESS_KEY: identity.secret,
        AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      });
      const provider = providerIdentity({
        endpoint,
        fixtureImage: config.objectImage,
        region: "us-east-1",
      });
      const evidence = await runObjectCompatibilityProbe({
        awsExecutable: config.awsExecutable,
        bodyPath,
        bucket,
        checksum: `sha256:${createHash("sha256").update(body).digest("hex")}`,
        deleteEnvironment: awsEnvironment(identities.delete),
        endpoint,
        heal: async () => {
          await docker.heal(objectName);
          const healed = await docker.inspectContainerConfinement(
            objectName,
            "1000:1000",
            [rootAccess, rootSecret],
            objectIdentity,
            { destination: "/data", kind: "tmpfs" },
            9000,
            config.objectImage,
            objectSecretMounts,
            objectProcess,
          );
          if (
            healed.internalNetworkEndpoint.ipv4Address !==
            objectDockerConfinement.internalNetworkEndpoint.ipv4Address
          )
            throw new Error("docker_internal_endpoint_identity_changed");
        },
        key,
        overwriteBodyPath,
        overwriteChecksum: `sha256:${createHash("sha256").update(overwriteBody).digest("hex")}`,
        partition: () => docker.partition(objectName),
        prefix,
        provider,
        restart: async () => {
          return restartConfinedMinio({
            beforeConfinement: objectDockerConfinement,
            docker,
            identity: objectIdentity,
            inspectConfinement: () =>
              docker.inspectContainerConfinement(
                objectName,
                "1000:1000",
                [rootAccess, rootSecret],
                objectIdentity,
                { destination: "/data", kind: "tmpfs" },
                9000,
                config.objectImage,
                objectSecretMounts,
                objectProcess,
              ),
            name: objectName,
            ready: objectReady,
            waitFor,
          });
        },
        runId: config.runId,
        runner,
        sizeBytes: body.byteLength,
        uploadEnvironment: awsEnvironment(identities.upload),
        verifyEnvironment: awsEnvironment(identities.verify),
      });
      const recordedEvidence = {
        ...evidence,
        dockerConfinement: objectDockerConfinement,
        fixtureClientImage: config.objectClientImage,
      };
      components.set(
        "object_compatibility_fixture",
        evidence.scopeComplete &&
          evidence.adapterConditionalCreate === true &&
          evidence.credentialEnforcedImmutability === false &&
          evidence.deleteIdentityDistinct === true &&
          evidence.exactProviderIdentity.compatibilityOnly === true &&
          evidence.exactProviderIdentity.productionProviderApproved === false &&
          evidence.networkPartitionReconciled === true &&
          evidence.overwriteChangedServerChecksum === true &&
          evidence.overwriteUsedOriginalCredential === true &&
          evidence.restartReconciled === true &&
          evidence.uploadCredentialCanOverwrite === true &&
          evidence.verificationIdentityDistinct === true
          ? passed("object_compatibility_fixture", recordedEvidence)
          : blocked(
              "object_compatibility_fixture",
              "object_compatibility_evidence_incomplete",
              [
                evidenceRecord(
                  "object_compatibility_real_evidence",
                  false,
                  recordedEvidence,
                ),
              ],
            ),
      );
    } catch (error) {
      components.set(
        "object_compatibility_fixture",
        blocked("object_compatibility_fixture", reasonCode(error)),
      );
    }
    try {
      const evidence = await runAzureObjectProductionStage({
        config,
        docker,
        entrypointFile: azuriteEntrypointScript,
        ledger,
        secrets,
        waitFor,
      });
      components.set(
        "object_production_provider",
        passed("object_production_provider", evidence),
      );
    } catch (error) {
      components.set(
        "object_production_provider",
        blocked("object_production_provider", reasonCode(error)),
      );
    }

    try {
      const allocation = await ensureSystemdAllocation();
      const serverDirectory = `${allocation.root}/hq-server`;
      await mkdir(serverDirectory, { mode: 0o700 });
      await chown(serverDirectory, allocation.uid, allocation.gid);
      const gatewayWalPath = `${allocation.root}/hq-gateway/authority.wal`;
      const operationKey = `${config.runId}-hq-job`;
      let hqServerUnit;
      let hqCommandSequence = 0;
      const confinedRunner = Object.freeze({
        run: async (executable, args, limits) => {
          hqCommandSequence += 1;
          return processManager.execute(
            executable,
            args,
            `hq-cli-${String(hqCommandSequence)}`,
            {
              joinNetworkOf: hqServerUnit,
              limits,
            },
          );
        },
      });
      const evidence = await runHyperQueueCompatibilityProbe({
        archivePath: config.hqArchive,
        binaryPath: config.hqBinary,
        clock: Date.now,
        executeGatewayProbe: (input) =>
          processManager.execute(
            config.nodeExecutable,
            [
              hyperQueueGatewayProbeScript,
              "--binary",
              config.hqBinary,
              "--binary-sha256",
              input.binarySha256,
              "--operation",
              input.operation,
              "--operation-key",
              operationKey,
              "--server-directory",
              serverDirectory,
              "--shim-executable",
              hyperQueueSyntheticShim,
              "--wal-path",
              gatewayWalPath,
            ],
            input.operation === "submit-and-recover"
              ? "hq-gateway-submit"
              : "hq-gateway-replay",
            {
              joinNetworkOf: hqServerUnit,
              limits: { timeoutMs: 25_000 },
            },
          ),
        gatewayWalPath,
        jobName: operationKey,
        runner: confinedRunner,
        serverDirectory,
        startProcess: async (executable, args, role, options) => {
          const process = await processManager.start(executable, args, role, {
            ...options,
            joinNetworkOf: role.startsWith("hq-server")
              ? undefined
              : hqServerUnit,
          });
          if (role.startsWith("hq-server")) hqServerUnit = process.unit;
          return process;
        },
        stopProcess: (process) => processManager.stop(process),
        syntheticShimExecutable: hyperQueueSyntheticShim,
        wait,
      });
      components.set(
        "hyperqueue_0_26_2",
        passed("hyperqueue_0_26_2", evidence),
      );
    } catch (error) {
      components.set(
        "hyperqueue_0_26_2",
        blocked("hyperqueue_0_26_2", reasonCode(error)),
      );
    }

    try {
      await ensureSystemdAllocation();
      const capability = systemdCapability;
      if (capability === undefined)
        throw new Error("systemd_capability_preflight_incomplete");
      if (
        !capability.report.capabilities.ephemeral_disk_quota ||
        !capability.report.capabilities.ephemeral_disk_inode_quota
      )
        throw new Error("project_quota_capability_not_proven");
      capability.verifyProjectQuota();
      const io = createSystemdProbeIo({
        ...config,
        ledger,
        sliceOwnership,
        runner,
      });
      systemdEvidence = await runSystemdGateProbe({
        ...config,
        ...io,
        capabilityEvidence: capability.evidence,
        capabilityReport: capability.report,
        clock: Date.now,
        fixturePath: systemdFixturePath,
        preciseClock: monotonicMilliseconds,
        reviewedExecutables: reviewed.executableSet,
        runner,
        sliceOwnership,
        wait,
      });
      components.set(
        "systemd_cgroup_v2",
        passed("systemd_cgroup_v2", {
          ...systemdEvidence,
          projectQuota: capability.evidence.projectQuota,
        }),
      );
    } catch (error) {
      const code = reasonCode(error);
      const status = new Set([
        "cgroup_v2_controller_missing",
        "systemd_synthetic_identity_missing",
        "systemd_manager_unavailable",
        "systemd_version_unsupported",
        "cgroup_v2_unsupported",
        "project_quota_filesystem_unsupported",
        "project_quota_kernel_capability_missing",
        "project_quota_mount_option_missing",
        "project_quota_quotactl_fd_unavailable",
        "systemd_required_property_unsupported",
      ]).has(code)
        ? "UNSUPPORTED"
        : "BLOCKED";
      components.set(
        "systemd_cgroup_v2",
        blocked(
          "systemd_cgroup_v2",
          code,
          systemdCapabilityEvidence === undefined
            ? []
            : [
                evidenceRecord(
                  "systemd_real_capability_preflight",
                  true,
                  systemdCapabilityEvidence,
                ),
              ],
          status,
        ),
      );
    }

    try {
      const allocation = await ensureSystemdAllocation();
      const { complete, evidence } = await runPressureAdmissionStage({
        allocation,
        config,
        postgres,
        processManager,
        runner,
        systemdCapabilityEvidence,
        systemdEvidence,
        wait,
      });
      components.set(
        "pressure_admission_slo",
        complete
          ? passed("pressure_admission_slo", evidence)
          : blocked(
              "pressure_admission_slo",
              "live_pressure_pause_reopen_or_slo_not_proven",
              [
                evidenceRecord(
                  "mixed_workload_real_measurement",
                  false,
                  evidence,
                ),
              ],
            ),
      );
    } catch (error) {
      components.set(
        "pressure_admission_slo",
        blocked("pressure_admission_slo", reasonCode(error)),
      );
    }
  }

  for (const id of DECLARED_COMPONENTS)
    if (id !== "cleanup" && !components.has(id))
      components.set(
        id,
        blocked(id, "preflight_or_prerequisite_not_satisfied"),
      );

  const cleanup = await ledger.cleanup();
  components.set(
    "cleanup",
    cleanup.certain
      ? passed("cleanup", cleanup)
      : blocked("cleanup", "owned_resource_cleanup_uncertain", [
          evidenceRecord("cleanup_real_outcomes", false, cleanup),
        ]),
  );
  const redact = createRedactor(secrets);
  const evidence = finalizeEvidence({
    components: DECLARED_COMPONENTS.map((id) => redact(components.get(id))),
    finishedAt: new Date().toISOString(),
    host: await observedHostIdentity(reviewed.evidence),
    runId: config.runId,
    startedAt,
  });
  await writeEvidenceAtomically(config.evidencePath, evidence);
  process.stdout.write(`${config.evidencePath}\n`);
  process.exitCode = evidence.overallVerdict === "PASS" ? 0 : 1;
}

await main();
