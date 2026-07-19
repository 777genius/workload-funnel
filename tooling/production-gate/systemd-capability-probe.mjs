import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";

import {
  cleanupProjectQuotaRecord,
  serializeProjectQuotaControl,
  serializeProjectQuotaReceipt,
} from "./project-quota-runtime.mjs";
import { SYSTEMD_GATE_PROJECT_QUOTA_BYTES } from "./systemd-contract.mjs";

const verifiedProperties = Object.freeze([
  "AmbientCapabilities",
  "CapabilityBoundingSet",
  "CPUQuotaPerSecUSec",
  "CPUWeight",
  "DevicePolicy",
  "FinalKillSignal",
  "Group",
  "IOReadBandwidthMax",
  "IOWeight",
  "IOWriteBandwidthMax",
  "KillMode",
  "KillSignal",
  "LimitNOFILE",
  "MemoryHigh",
  "MemoryMax",
  "MemorySwapMax",
  "NoNewPrivileges",
  "PrivateDevices",
  "PrivateMounts",
  "PrivateNetwork",
  "PrivateTmp",
  "ProtectControlGroups",
  "ProtectHome",
  "ProtectKernelModules",
  "ProtectKernelTunables",
  "ProtectSystem",
  "ReadWritePaths",
  "RuntimeMaxUSec",
  "SendSIGKILL",
  "SystemCallFilter",
  "TasksMax",
  "TimeoutStopUSec",
  "User",
]);

function verificationUnit(config) {
  return [
    "[Unit]",
    "Description=WorkloadFunnel non-mutating production gate capability verification",
    "[Service]",
    "Type=exec",
    `ExecStart=${config.nodeExecutable} --version`,
    "Environment=HOME=/nonexistent",
    "Environment=LANG=C.UTF-8",
    "Environment=LC_ALL=C.UTF-8",
    "Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "Environment=TZ=UTC",
    `User=${config.workloadUser}`,
    `Group=${config.workloadGroup}`,
    "AmbientCapabilities=",
    "CapabilityBoundingSet=",
    "CPUQuota=50%",
    "CPUWeight=100",
    "DevicePolicy=closed",
    `IOReadBandwidthMax=${config.ioDevice} 1048576`,
    "IOWeight=100",
    `IOWriteBandwidthMax=${config.ioDevice} 524288`,
    "KillMode=control-group",
    "KillSignal=SIGTERM",
    "FinalKillSignal=SIGKILL",
    "SendSIGKILL=yes",
    "LimitNOFILE=1024",
    "LockPersonality=yes",
    "MemoryHigh=67108864",
    "MemoryMax=100663296",
    "MemorySwapMax=0",
    "NoNewPrivileges=yes",
    "PrivateDevices=yes",
    "PrivateMounts=yes",
    "PrivateNetwork=yes",
    "PrivateTmp=yes",
    "ProcSubset=pid",
    "ProtectClock=yes",
    "ProtectControlGroups=yes",
    "ProtectHome=yes",
    "ProtectHostname=yes",
    "ProtectKernelLogs=yes",
    "ProtectKernelModules=yes",
    "ProtectKernelTunables=yes",
    "ProtectProc=invisible",
    "ProtectSystem=strict",
    `ReadWritePaths=${config.workloadRoot}`,
    "RestrictAddressFamilies=AF_UNIX",
    "RestrictNamespaces=yes",
    "RestrictRealtime=yes",
    "RestrictSUIDSGID=yes",
    "RuntimeMaxSec=5s",
    "SystemCallArchitectures=native",
    "SystemCallFilter=@system-service",
    "SystemCallFilter=~@mount @privileged @resources @reboot",
    "TasksMax=16",
    "TimeoutStopSec=5s",
    "UMask=0077",
    "",
  ].join("\n");
}

export async function probeRealSystemdCapabilities(
  config,
  {
    hostPlatform = platform,
    projectQuotaApplication,
    read = readFile,
    write = writeFile,
  } = {},
) {
  const versionResult = await config.runner.run(
    config.systemctlExecutable,
    ["--version"],
    { timeoutMs: 2_000 },
  );
  const systemdVersion = Number(
    versionResult.stdout.match(/^systemd\s+(\d+)/u)?.[1],
  );
  if (
    versionResult.code !== 0 ||
    !Number.isSafeInteger(systemdVersion) ||
    systemdVersion < 250
  )
    throw new Error("systemd_version_unsupported");
  const managerResult = await config.runner.run(
    config.systemctlExecutable,
    ["show", "--property=Version", "--value", "--no-pager"],
    { timeoutMs: 2_000 },
  );
  const managerVersion = Number(managerResult.stdout.match(/^(\d+)/u)?.[1]);
  if (
    managerResult.code !== 0 ||
    !Number.isSafeInteger(managerVersion) ||
    managerVersion !== systemdVersion
  )
    throw new Error("systemd_manager_unavailable");
  let controllers;
  try {
    controllers = (await read("/sys/fs/cgroup/cgroup.controllers", "utf8"))
      .trim()
      .split(/\s+/u);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("cgroup_v2_unsupported");
    throw error;
  }
  if (
    controllers.some((name) => !/^[a-z_]+$/u.test(name)) ||
    ["cpu", "io", "memory", "pids"].some((name) => !controllers.includes(name))
  )
    throw new Error("cgroup_v2_controller_missing");
  const unit = verificationUnit(config);
  const unitPath = `${config.sandboxRoot}/systemd-capability-probe.service`;
  await write(unitPath, unit, { flag: "wx", mode: 0o600 });
  const verified = await config.runner.run(
    config.systemdAnalyzeExecutable,
    ["--man=no", "verify", unitPath],
    { timeoutMs: 5_000 },
  );
  if (verified.code !== 0 || verified.stderr.trim().length !== 0)
    throw new Error("systemd_required_property_unsupported");
  let quotaCapability;
  let quotaControl;
  let serializedQuotaReceipt;
  let verifyProjectQuota;
  if (projectQuotaApplication === undefined) {
    const quotaAdapter =
      await import("@workload-funnel/executor-systemd/transient-unit-start");
    const quotaMapping =
      await import("@workload-funnel/executor-systemd/cgroup-resource-mapping");
    const quotaConfig = Object.freeze({
      expectedHelperMode: "production",
      expectedHelperSha256: config.projectQuotaHelperSha256,
      nativeHelperPath: config.projectQuotaHelper,
    });
    quotaCapability =
      quotaAdapter.probeLinuxProjectQuotaCapability(quotaConfig);
    const quotaFence = Object.freeze({
      allocationId: config.runId,
      attemptId: `${config.runId}:attempt`,
      clusterIncarnation: `${config.runId}:cluster`,
      clusterIncarnationVersion: 1,
      desiredEffect: "process_start",
      effectScopeKey: `allocation:${config.runId}:process-start`,
      executionGeneration: `${config.runId}:generation-1`,
      expectedDesiredVersion: 1,
      issuedStartRevocationRevision: 0,
      namespaceId: "workload-funnel-production-gate",
      namespaceWriterEpoch: 1,
      nodeBootEpoch: 1,
      nodeId: `${config.runId}:node`,
      operationGateRevision: 1,
      ownerFence: 1,
      requiredGate: "process_start",
      schemaVersion: 1,
      startFence: `${config.runId}:start-fence`,
      supersessionKey: `allocation:${config.runId}:start`,
    });
    quotaControl = Object.freeze({
      allocationId: config.runId,
      inodeMaximum: 4_096n,
      maximumBytes: BigInt(SYSTEMD_GATE_PROJECT_QUOTA_BYTES),
      projectId: quotaMapping.deterministicProjectQuotaId(config.runId),
      root: config.workloadRoot,
    });
    const cleanupExpected = Object.freeze({
      adapterConfig: quotaConfig,
      capability: quotaCapability,
      control: serializeProjectQuotaControl(quotaControl),
      fence: quotaFence,
    });
    const quotaCleanupRecord = await config.ledger.prepare(
      "project-quota",
      `${config.runId}-project-quota`,
      cleanupExpected,
    );
    const quotaManager = new quotaAdapter.LinuxProjectQuotaManager(
      quotaConfig,
      quotaCapability,
    );
    const quotaReceipt = quotaManager.applyProjectQuota(
      quotaControl,
      quotaFence,
    );
    if (
      !quotaManager.verifyProjectQuotaReceipt(
        quotaControl,
        quotaReceipt,
        quotaFence,
      )
    )
      throw new Error("project_quota_receipt_verification_failed");
    serializedQuotaReceipt = serializeProjectQuotaReceipt(quotaReceipt);
    await config.ledger.finalize(
      quotaCleanupRecord,
      { receipt: serializedQuotaReceipt },
      () =>
        cleanupProjectQuotaRecord({
          expected: cleanupExpected,
          observed: { receipt: serializedQuotaReceipt },
        }),
    );
    verifyProjectQuota = () => {
      if (
        !quotaManager.verifyProjectQuotaReceipt(
          quotaControl,
          quotaReceipt,
          quotaFence,
        )
      )
        throw new Error("project_quota_receipt_verification_failed");
    };
  } else {
    const applied = await projectQuotaApplication(config);
    quotaCapability = applied?.capability;
    quotaControl = applied?.control;
    serializedQuotaReceipt = applied?.receipt;
    if (
      quotaCapability?.byteQuota !== true ||
      quotaCapability.inodeQuota !== true ||
      typeof serializedQuotaReceipt?.receiptDigest !== "string"
    )
      throw new Error("project_quota_capability_not_proven");
    verifyProjectQuota = () => undefined;
  }
  const { discoverSystemdCapabilities } =
    await import("@workload-funnel/executor-systemd/capability-discovery");
  const report = discoverSystemdCapabilities(
    Object.freeze({
      authorizedUnlimitedSwap: false,
      cgroupV2Controllers: Object.freeze([...controllers]),
      linux: hostPlatform() === "linux",
      pinnedExecutionPaths: false,
      projectQuotaBytes: quotaCapability.byteQuota,
      projectQuotaInodes: quotaCapability.inodeQuota,
      source: "disposable_linux_host",
      storageHeadroomEnforcement: true,
      systemdProperties: verifiedProperties,
      systemdVersion,
      unifiedCgroupV2: true,
    }),
  );
  return Object.freeze({
    evidence: Object.freeze({
      cgroupV2Controllers: Object.freeze([...controllers]),
      projectQuotaMutatingProbe: true,
      systemdPropertyVerificationNonMutating: true,
      projectQuota: Object.freeze({
        capability: quotaCapability,
        control: serializeProjectQuotaControl(quotaControl),
        receipt: serializedQuotaReceipt,
      }),
      projectQuotaBytes: true,
      projectQuotaInodes: true,
      propertyCount: verifiedProperties.length,
      systemdManagerVersion: managerVersion,
      systemdVersion,
      verificationUnitSha256: createHash("sha256")
        .update(unit, "utf8")
        .digest("hex"),
    }),
    report,
    verifyProjectQuota,
  });
}
