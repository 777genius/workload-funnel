import { lstat, readFile, readdir } from "node:fs/promises";
import { statfs } from "node:fs/promises";
import { availableParallelism } from "node:os";

import { parseMemoryInfo, parsePsi } from "./pressure.mjs";

export function parseLoadAverage(text, cpuCount) {
  const load = Number(text.trim().split(/\s+/u)[0]);
  if (
    !Number.isFinite(load) ||
    load < 0 ||
    !Number.isSafeInteger(cpuCount) ||
    cpuCount < 1
  )
    throw new Error("malformed_load_observation");
  return load / cpuCount;
}

export async function observeHost({
  clock = Date.now,
  cpuCount = availableParallelism(),
  gateStorage,
  pressureCgroups = [],
  read = readFile,
  sandboxRoot,
  stat = statfs,
} = {}) {
  const observedAtMs = clock();
  let sources;
  try {
    sources = await Promise.all([
      read("/proc/pressure/cpu", "utf8"),
      read("/proc/pressure/io", "utf8"),
      read("/proc/loadavg", "utf8"),
      read("/proc/meminfo", "utf8"),
      read("/proc/pressure/memory", "utf8"),
      stat(sandboxRoot),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT")
      throw new Error("host_pressure_interface_unsupported");
    throw error;
  }
  const [cpu, io, load, memory, memoryPsi, disk] = sources;
  const cpuPressure = parsePsi(cpu, { requireFull: false });
  const ioPressure = parsePsi(io);
  const memoryPressure = parsePsi(memoryPsi);
  const memoryInfo = parseMemoryInfo(memory);
  const diskTotalBytes = Number(disk.blocks) * Number(disk.bsize);
  const diskFreeBytes = Number(disk.bavail) * Number(disk.bsize);
  const inodeTotal = Number(disk.files);
  const inodeFree = Number(disk.ffree);
  if (
    !Number.isSafeInteger(diskTotalBytes) ||
    !Number.isSafeInteger(diskFreeBytes) ||
    diskTotalBytes <= 0 ||
    diskFreeBytes < 0 ||
    diskFreeBytes > diskTotalBytes ||
    !Number.isSafeInteger(inodeTotal) ||
    !Number.isSafeInteger(inodeFree) ||
    inodeTotal <= 0 ||
    inodeFree < 0 ||
    inodeFree > inodeTotal
  )
    throw new Error("malformed_disk_observation");
  const workloadPressure = await observeCgroupPressure(pressureCgroups, read);
  const storage =
    gateStorage === undefined
      ? { gateDiskUsedRatio: 0, gateInodeUsedRatio: 0 }
      : await observeGateStorage(gateStorage);
  const nowMs = clock();
  return Object.freeze({
    cpuPsiSome: Math.max(cpuPressure.some.avg10, workloadPressure.cpuPsiSome),
    diskFreeBytes,
    diskFreeRatio: diskFreeBytes / diskTotalBytes,
    ...storage,
    hostCpuPsiSome: cpuPressure.some.avg10,
    hostIoPsiSome: ioPressure.some.avg10,
    hostMemoryPsiSome: memoryPressure.some.avg10,
    inodeFree,
    inodeFreeRatio: inodeFree / inodeTotal,
    ioPsiSome: Math.max(ioPressure.some.avg10, workloadPressure.ioPsiSome),
    loadPerCpu: parseLoadAverage(load, cpuCount),
    memoryAvailableRatio: memoryInfo.availableRatio,
    memoryPsiSome: Math.max(
      memoryPressure.some.avg10,
      workloadPressure.memoryPsiSome,
    ),
    nowMs,
    observationCollectionMs: nowMs - observedAtMs,
    observedAtMs,
    workloadCpuPsiSome: workloadPressure.cpuPsiSome,
    workloadIoPsiSome: workloadPressure.ioPsiSome,
    workloadMemoryPsiSome: workloadPressure.memoryPsiSome,
  });
}

async function observeCgroupPressure(controlGroups, read) {
  if (
    !Array.isArray(controlGroups) ||
    controlGroups.some(
      (path) => typeof path !== "string" || !/^\/[A-Za-z0-9_./-]+$/u.test(path),
    )
  )
    throw new Error("cgroup_pressure_scope_invalid");
  const values = { cpuPsiSome: 0, ioPsiSome: 0, memoryPsiSome: 0 };
  for (const controlGroup of controlGroups) {
    for (const [kind, name] of [
      ["cpu", "cpuPsiSome"],
      ["io", "ioPsiSome"],
      ["memory", "memoryPsiSome"],
    ]) {
      try {
        const parsed = parsePsi(
          await read(`/sys/fs/cgroup${controlGroup}/${kind}.pressure`, "utf8"),
          { requireFull: kind !== "cpu" },
        );
        values[name] = Math.max(values[name], parsed.some.avg10);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  return Object.freeze(values);
}

export async function observeGateStorage({
  inspect = lstat,
  list = readdir,
  maximumBytes,
  maximumInodes,
  root,
}) {
  if (
    !root.startsWith("/") ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    !Number.isSafeInteger(maximumInodes) ||
    maximumInodes < 1
  )
    throw new Error("gate_storage_observation_invalid");
  let bytes = 0;
  let inodes = 0;
  const visit = async (path) => {
    let entries;
    try {
      entries = await list(path, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (let offset = 0; offset < entries.length; offset += 64) {
      const batch = entries.slice(offset, offset + 64);
      if (inodes + batch.length > maximumInodes * 2)
        throw new Error("gate_storage_inode_bound_exceeded");
      const identities = await Promise.all(
        batch.map(async (entry) => ({
          child: `${path}/${entry.name}`,
          identity: await inspect(`${path}/${entry.name}`),
        })),
      );
      const directories = [];
      for (const { child, identity } of identities) {
        if (identity.isSymbolicLink())
          throw new Error("gate_storage_symlink_refused");
        inodes += 1;
        if (identity.isDirectory()) directories.push(child);
        else if (identity.isFile()) bytes += identity.size;
        else throw new Error("gate_storage_entry_invalid");
        if (bytes > maximumBytes * 2)
          throw new Error("gate_storage_byte_bound_exceeded");
      }
      for (const directory of directories) await visit(directory);
    }
  };
  await visit(root);
  return Object.freeze({
    gateDiskUsedRatio: bytes / maximumBytes,
    gateInodeUsedRatio: inodes / maximumInodes,
    gateStorageBytes: bytes,
    gateStorageInodes: inodes,
  });
}
