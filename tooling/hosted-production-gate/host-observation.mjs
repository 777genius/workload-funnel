import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  statfs,
} from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";

import {
  ALLOCATION_MOUNT,
  HOSTED_RUNNER_PROCESS_BASELINE,
  HOSTED_RUNNER_SERVICE_BASELINE,
  SANDBOX_PARENT,
  SYNTHETIC_USER,
} from "./constants.mjs";
import { HostedGateRefusal } from "./contract.mjs";
import { inspectExecutable } from "./review-manifest.mjs";
import { runCommand } from "./process-runner.mjs";

const TOOL_CANDIDATES = Object.freeze({
  aptGet: ["/usr/bin/apt-get"],
  chmod: ["/usr/bin/chmod", "/bin/chmod"],
  chown: ["/usr/bin/chown", "/bin/chown"],
  cp: ["/usr/bin/cp", "/bin/cp"],
  docker: ["/usr/bin/docker"],
  dpkgQuery: ["/usr/bin/dpkg-query"],
  findmnt: ["/usr/bin/findmnt"],
  getent: ["/usr/bin/getent"],
  git: ["/usr/bin/git"],
  gpg: ["/usr/bin/gpg"],
  groupadd: ["/usr/sbin/groupadd"],
  groupdel: ["/usr/sbin/groupdel"],
  id: ["/usr/bin/id"],
  install: ["/usr/bin/install"],
  losetup: ["/usr/sbin/losetup"],
  mount: ["/usr/bin/mount", "/bin/mount"],
  systemctl: ["/usr/bin/systemctl", "/bin/systemctl"],
  tar: ["/usr/bin/tar", "/bin/tar"],
  truncate: ["/usr/bin/truncate"],
  umount: ["/usr/bin/umount", "/bin/umount"],
  unzip: ["/usr/bin/unzip"],
  useradd: ["/usr/sbin/useradd"],
  userdel: ["/usr/sbin/userdel"],
});

async function resolveTool(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

async function inspectTools() {
  const result = {};
  for (const [name, candidates] of Object.entries(TOOL_CANDIDATES)) {
    const path = await resolveTool(candidates);
    if (path !== undefined) result[name] = await inspectExecutable(path);
  }
  return Object.freeze(result);
}

function lines(value) {
  return value
    .trim()
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function successful(executable, arguments_, code) {
  const result = await runCommand(executable, arguments_);
  if (result.code !== 0) throw new HostedGateRefusal(code);
  return result.stdout;
}

function parsePsi(value) {
  const line = lines(value).find((item) => item.startsWith("some "));
  const match = line?.match(/(?:^|\s)avg10=([0-9]+(?:\.[0-9]+)?)(?:\s|$)/u);
  if (match === undefined || match === null)
    throw new HostedGateRefusal("host_psi_malformed");
  const average = Number(match[1]) / 100;
  if (!Number.isFinite(average) || average < 0 || average > 1)
    throw new HostedGateRefusal("host_psi_malformed");
  return average;
}

function parseMemory(value) {
  const entries = new Map();
  for (const line of lines(value)) {
    const match = line.match(/^([A-Za-z_()]+):\s+([0-9]+)\s+kB$/u);
    if (match !== null) entries.set(match[1], Number(match[2]) * 1024);
  }
  const total = entries.get("MemTotal");
  const available = entries.get("MemAvailable");
  if (!(total > 0) || !(available >= 0) || available > total)
    throw new HostedGateRefusal("host_memory_malformed");
  return Object.freeze({ available, total });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function processUnit(cgroup) {
  return cgroup
    .split("\n")
    .map((line) => line.split(":", 3)[2] ?? "")
    .flatMap((path) => path.split("/"))
    .find((part) => part.endsWith(".service"));
}

function parseProcessStatus(value) {
  const ppid = Number(value.match(/^PPid:\s+([0-9]+)$/mu)?.[1]);
  const uidFields = value.match(/^Uid:\s+([0-9]+)\s+([0-9]+)/mu);
  const uid = Number(uidFields?.[2]);
  if (!Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid))
    throw new HostedGateRefusal("host_process_status_malformed");
  return Object.freeze({ ppid, uid });
}

export async function processInventory({
  list = readdir,
  read = readFile,
  resolveExecutable = realpath,
} = {}) {
  const result = [];
  for (const entry of await list("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    try {
      const [cgroup, comm, status] = await Promise.all([
        read(`/proc/${entry.name}/cgroup`, "utf8"),
        read(`/proc/${entry.name}/comm`, "utf8"),
        read(`/proc/${entry.name}/status`, "utf8"),
      ]);
      const parsed = parseProcessStatus(status);
      let executable = null;
      try {
        executable = await resolveExecutable(`/proc/${entry.name}/exe`);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      result.push(
        Object.freeze({
          cgroup: cgroup.trim(),
          comm: comm.trim(),
          executable,
          pid: Number(entry.name),
          ppid: parsed.ppid,
          uid: parsed.uid,
          unit: processUnit(cgroup) ?? null,
        }),
      );
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return Object.freeze(result.sort((left, right) => left.pid - right.pid));
}

export function classifyForeignProcesses(
  processes,
  { currentPid = process.pid, runnerUid } = {},
) {
  if (!Number.isSafeInteger(runnerUid) || runnerUid < 1)
    throw new HostedGateRefusal("host_runner_uid_invalid");
  const byPid = new Map(processes.map((item) => [item.pid, item]));
  const currentAncestry = new Set();
  for (let pid = currentPid; Number.isSafeInteger(pid) && pid > 0; ) {
    if (currentAncestry.has(pid))
      throw new HostedGateRefusal("host_process_inventory_cycle");
    currentAncestry.add(pid);
    pid = byPid.get(pid)?.ppid ?? 0;
  }
  const kernelProcesses = new Set([2]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of processes)
      if (!kernelProcesses.has(item.pid) && kernelProcesses.has(item.ppid)) {
        kernelProcesses.add(item.pid);
        changed = true;
      }
  }
  const serviceProcessCounts = new Map();
  for (const item of processes)
    if (
      item.unit !== null &&
      !currentAncestry.has(item.pid) &&
      !kernelProcesses.has(item.pid)
    )
      serviceProcessCounts.set(
        item.unit,
        (serviceProcessCounts.get(item.unit) ?? 0) + 1,
      );
  return Object.freeze(
    processes.filter((item) => {
      if (currentAncestry.has(item.pid)) return false;
      if (
        item.pid === 1 &&
        item.uid === 0 &&
        item.comm === "systemd" &&
        item.executable === "/usr/lib/systemd/systemd"
      )
        return false;
      if (
        kernelProcesses.has(item.pid) &&
        item.uid === 0 &&
        item.executable === null &&
        item.unit === null
      )
        return false;
      const baseline = HOSTED_RUNNER_PROCESS_BASELINE[item.unit];
      if (baseline === undefined) return true;
      const ownerMatches =
        baseline.owner === "runner"
          ? item.uid === runnerUid
          : baseline.owner === "root"
            ? item.uid === 0
            : item.uid >= 0 && item.uid < 1000 && item.uid !== runnerUid;
      return (
        !ownerMatches ||
        !baseline.executables.includes(item.executable) ||
        serviceProcessCounts.get(item.unit) > baseline.maxProcesses
      );
    }),
  );
}

async function getentExists(executable, kind, name) {
  const result = await runCommand(executable, [kind, name]);
  if (result.code === 0) return true;
  if (result.code === 2) return false;
  throw new HostedGateRefusal("host_identity_inventory_failed");
}

export async function observePristineHost(context) {
  const tools = await inspectTools();
  const docker = tools.docker?.path;
  const systemctl = tools.systemctl?.path;
  if (
    docker === undefined ||
    systemctl === undefined ||
    tools.getent === undefined
  )
    throw new HostedGateRefusal("bootstrap_tool_inventory_incomplete");
  const [
    pid1,
    controllersText,
    cgroupStats,
    systemdVersionText,
    dockerVersion,
    containers,
    images,
    networks,
    volumes,
    serviceUnits,
    memoryText,
    loadText,
    cpuPsi,
    ioPsi,
    memoryPsi,
    disk,
    pidsCurrentText,
    pidsMaxText,
    processInventoryResult,
  ] = await Promise.all([
    readFile("/proc/1/comm", "utf8"),
    readFile("/sys/fs/cgroup/cgroup.controllers", "utf8"),
    statfs("/sys/fs/cgroup"),
    successful(systemctl, ["--version"], "systemd_version_probe_failed"),
    successful(
      docker,
      ["version", "--format", "{{.Server.Version}}"],
      "docker_server_not_proven",
    ),
    successful(
      docker,
      ["container", "ls", "--all", "--quiet"],
      "docker_inventory_failed",
    ),
    successful(
      docker,
      ["image", "ls", "--all", "--quiet"],
      "docker_inventory_failed",
    ),
    successful(
      docker,
      ["network", "ls", "--format", "{{.Name}}"],
      "docker_inventory_failed",
    ),
    successful(docker, ["volume", "ls", "--quiet"], "docker_inventory_failed"),
    successful(
      systemctl,
      [
        "list-units",
        "--no-legend",
        "--plain",
        "--state=running",
        "--type=service",
      ],
      "systemd_workload_inventory_failed",
    ),
    readFile("/proc/meminfo", "utf8"),
    readFile("/proc/loadavg", "utf8"),
    readFile("/proc/pressure/cpu", "utf8"),
    readFile("/proc/pressure/io", "utf8"),
    readFile("/proc/pressure/memory", "utf8"),
    statfs(context.runnerTemp),
    readFile("/sys/fs/cgroup/pids.current", "utf8"),
    readFile("/sys/fs/cgroup/pids.max", "utf8"),
    processInventory(),
  ]);
  const memory = parseMemory(memoryText);
  const cpuCount = availableParallelism();
  const pidsCurrent = Number(pidsCurrentText.trim());
  const pidsMaximum =
    pidsMaxText.trim() === "max"
      ? Number((await readFile("/proc/sys/kernel/pid_max", "utf8")).trim())
      : Number(pidsMaxText.trim());
  const systemdVersion = Number(
    systemdVersionText.match(/^systemd ([0-9]+)(?:\s|$)/u)?.[1],
  );
  const defaultNetworks = new Set(["bridge", "host", "none"]);
  const observedServices = lines(serviceUnits).map(
    (line) => line.split(/\s+/u)[0],
  );
  const serviceBaseline = new Set(HOSTED_RUNNER_SERVICE_BASELINE);
  const foreignServices = observedServices.filter(
    (name) => !serviceBaseline.has(name),
  );
  const runnerUid = Number(process.env.SUDO_UID);
  const processes = classifyForeignProcesses(processInventoryResult, {
    currentPid: process.pid,
    runnerUid,
  });
  const foreignPaths = [];
  for (const path of [
    context.hostRoot,
    context.controlRoot,
    ALLOCATION_MOUNT,
    SANDBOX_PARENT.slice(0, -"/sandboxes".length),
    "/etc/apt/sources.list.d/workload-funnel-postgresql.list",
    "/usr/libexec/workload-funnel",
    "/usr/lib/postgresql/18",
    "/usr/share/keyrings/workload-funnel-postgresql.gpg",
  ])
    if (await pathExists(path)) foreignPaths.push(path);
  const blocks = Number(disk.blocks);
  const availableBlocks = Number(disk.bavail);
  const files = Number(disk.files);
  const freeFiles = Number(disk.ffree);
  return Object.freeze({
    cgroup: Object.freeze({
      controllers: Object.freeze(
        controllersText.trim().split(/\s+/u).filter(Boolean),
      ),
      filesystem:
        Number(cgroupStats.type) === 0x6367_7270 ? "cgroup2" : "other",
    }),
    docker: Object.freeze({
      containers: Object.freeze(lines(containers)),
      images: Object.freeze([...new Set(lines(images))]),
      nonDefaultNetworks: Object.freeze(
        lines(networks).filter((name) => !defaultNetworks.has(name)),
      ),
      serverVersion: dockerVersion.trim(),
      volumes: Object.freeze(lines(volumes)),
    }),
    foreign: Object.freeze({
      baseline: "github-hosted-ubuntu-24.04.v1",
      observedProcessCount: processInventoryResult.length,
      observedServices: Object.freeze(observedServices),
      paths: Object.freeze(foreignPaths),
      processes: Object.freeze(processes),
      syntheticGroupExists: await getentExists(
        tools.getent.path,
        "group",
        SYNTHETIC_USER,
      ),
      syntheticUserExists: await getentExists(
        tools.getent.path,
        "passwd",
        SYNTHETIC_USER,
      ),
    }),
    pid1: pid1.trim(),
    resources: Object.freeze({
      cpuCount,
      cpuPsiSome: parsePsi(cpuPsi),
      diskAvailableBytes: availableBlocks * Number(disk.bsize),
      diskAvailableRatio: availableBlocks / blocks,
      inodeAvailableRatio: freeFiles / files,
      ioPsiSome: parsePsi(ioPsi),
      loadPerCpu: Number(loadText.trim().split(/\s+/u)[0]) / cpuCount,
      memoryAvailableBytes: memory.available,
      memoryAvailableRatio: memory.available / memory.total,
      memoryPsiSome: parsePsi(memoryPsi),
      memoryTotalBytes: Math.min(memory.total, totalmem()),
      pidHeadroom: pidsMaximum - pidsCurrent,
    }),
    rootSudo: Object.freeze({
      effectiveUid: process.getuid?.(),
      sudoUid: /^[1-9][0-9]*$/u.test(process.env.SUDO_UID ?? "")
        ? Number(process.env.SUDO_UID)
        : null,
    }),
    systemd: Object.freeze({
      foreignUnits: Object.freeze(foreignServices),
      version: systemdVersion,
    }),
    tools,
  });
}
