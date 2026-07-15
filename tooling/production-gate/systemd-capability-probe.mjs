import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";

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
    "SystemCallFilter=@system-service ~@mount ~@privileged ~@resources ~@reboot",
    "TasksMax=16",
    "TimeoutStopSec=5s",
    "UMask=0077",
    "",
  ].join("\n");
}

export async function probeRealSystemdCapabilities(
  config,
  { hostPlatform = platform, read = readFile, write = writeFile } = {},
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
  if (verified.code !== 0)
    throw new Error("systemd_required_property_unsupported");
  const { discoverSystemdCapabilities } =
    await import("@workload-funnel/executor-systemd/capability-discovery");
  const report = discoverSystemdCapabilities(
    Object.freeze({
      authorizedUnlimitedSwap: false,
      cgroupV2Controllers: Object.freeze([...controllers]),
      linux: hostPlatform() === "linux",
      pinnedExecutionPaths: false,
      projectQuotaBytes: false,
      projectQuotaInodes: false,
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
      nonMutatingVerification: true,
      projectQuotaBytes: false,
      projectQuotaInodes: false,
      propertyCount: verifiedProperties.length,
      systemdManagerVersion: managerVersion,
      systemdVersion,
      verificationUnitSha256: createHash("sha256")
        .update(unit, "utf8")
        .digest("hex"),
    }),
    report,
  });
}
