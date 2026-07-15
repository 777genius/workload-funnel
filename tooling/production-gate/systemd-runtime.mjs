import {
  access,
  chown,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";

function unitAbsent(result) {
  const loadStates = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("LoadState="));
  return (
    (loadStates.length === 1 && loadStates[0] === "LoadState=not-found") ||
    (result.code !== 0 &&
      /(?:could not be found|not found|not loaded)/iu.test(result.stderr))
  );
}

function unitLoaded(result) {
  const loadStates = result.stdout
    .split("\n")
    .filter((line) => line.startsWith("LoadState="));
  return loadStates.length === 1 && loadStates[0] === "LoadState=loaded";
}

function unitInactiveOrAbsent(result) {
  return (
    unitAbsent(result) ||
    (result.code === 0 &&
      result.stdout.includes("ActiveState=inactive") &&
      result.stdout.includes("ControlGroup=\n"))
  );
}

export async function cleanupSystemdAllocationRecord(record) {
  const root = record.expected.path;
  if (
    typeof root !== "string" ||
    root !==
      `/var/lib/workload-funnel/allocations/${record.name.replace(/-allocation$/u, "")}`
  )
    throw new Error("systemd_allocation_cleanup_identity_invalid");
  let current;
  try {
    current = await lstat(root);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    (record.observed.device !== undefined &&
      (current.dev !== record.observed.device ||
        current.ino !== record.observed.inode ||
        current.uid !== record.observed.uid ||
        current.gid !== record.observed.gid))
  )
    throw new Error("systemd_allocation_identity_changed");
  await rm(root, { recursive: true });
}

export async function prepareSystemdAllocation(config) {
  const parent = "/var/lib/workload-funnel/allocations";
  const parentIdentity = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !parentIdentity.isDirectory() ||
    parentIdentity.isSymbolicLink() ||
    parentIdentity.uid !== 0 ||
    parentIdentity.gid !== 0 ||
    (parentIdentity.mode & 0o022) !== 0
  )
    throw new Error("systemd_allocation_parent_untrusted");
  const root = `${parent}/${config.runId}`;
  const user = await config.runner.run(
    config.idExecutable,
    ["--user", "workload-funnel-synthetic"],
    { timeoutMs: 2_000 },
  );
  const group = await config.runner.run(
    config.idExecutable,
    ["--group", "workload-funnel-synthetic"],
    { timeoutMs: 2_000 },
  );
  const uid = Number(user.stdout.trim());
  const gid = Number(group.stdout.trim());
  if (
    user.code !== 0 ||
    group.code !== 0 ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1
  )
    throw new Error("systemd_synthetic_identity_missing");
  const name = `${config.runId}-allocation`;
  try {
    await lstat(root);
    throw new Error("systemd_allocation_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const recordId = await config.ledger.prepare("systemd-allocation", name, {
    path: root,
  });
  await mkdir(root, { mode: 0o700 });
  await mkdir(`${root}/output`, { mode: 0o700 });
  await Promise.all([chown(root, uid, gid), chown(`${root}/output`, uid, gid)]);
  const identity = await lstat(root);
  const observed = {
    device: identity.dev,
    gid: identity.gid,
    inode: identity.ino,
    uid: identity.uid,
  };
  await config.ledger.finalize(recordId, observed, () =>
    cleanupSystemdAllocationRecord({
      expected: { path: root },
      name,
      observed,
    }),
  );
  return Object.freeze({
    gid,
    group: "workload-funnel-synthetic",
    root,
    uid,
    user: "workload-funnel-synthetic",
  });
}

export function createSystemdProbeIo(config) {
  const unitRecords = new Map();
  return Object.freeze({
    async readCgroupControllers() {
      const controllers = (
        await readFile("/sys/fs/cgroup/cgroup.controllers", "utf8")
      )
        .trim()
        .split(/\s+/u);
      if (controllers.some((name) => !/^[a-z_]+$/u.test(name)))
        throw new Error("cgroup_v2_controller_observation_malformed");
      return Object.freeze(controllers);
    },
    async ioBytesWritten(root) {
      try {
        return (await stat(`${root}/io-load.bin`)).size;
      } catch (error) {
        if (error?.code === "ENOENT") return 0;
        throw error;
      }
    },
    pidExists(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1)
        throw new Error("systemd_descendant_pid_invalid");
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    },
    async pidLimitObserved(root) {
      try {
        await access(`${root}/pids-limit-observed`);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw error;
      }
    },
    async readDescendantPids(root) {
      const value = JSON.parse(
        await readFile(`${root}/descendants.json`, "utf8"),
      );
      if (
        !Array.isArray(value) ||
        value.length < 2 ||
        value.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
      )
        throw new Error("systemd_descendant_manifest_invalid");
      return Object.freeze(value);
    },
    async prepareUnit(unit, description) {
      const recordId = await config.ledger.prepare("systemd-unit", unit, {
        description,
      });
      unitRecords.set(unit, { description, recordId });
    },
    async finalizeUnit(unit, values) {
      const prepared = unitRecords.get(unit);
      if (prepared === undefined)
        throw new Error("systemd_unit_prepare_missing");
      await config.sliceOwnership.register();
      const record = Object.freeze({
        expected: { description: prepared.description },
        name: unit,
        observed: { invocationId: values.InvocationID },
      });
      const cleanup = async () => {
        const before = await config.runner.run(
          config.systemctlExecutable,
          [
            "show",
            unit,
            "--property=Description,InvocationID,LoadState",
            "--no-pager",
          ],
          { timeoutMs: 2_000 },
        );
        if (unitAbsent(before)) return;
        if (
          before.code !== 0 ||
          !unitLoaded(before) ||
          !before.stdout.includes(
            `Description=${record.expected.description}\n`,
          ) ||
          !before.stdout.includes(
            `InvocationID=${record.observed.invocationId}\n`,
          )
        )
          throw new Error("systemd_unit_cleanup_uncertain");
        const stopped = await config.runner.run(
          config.systemctlExecutable,
          ["stop", unit],
          { timeoutMs: 2_000 },
        );
        if (stopped.code !== 0)
          throw new Error("systemd_unit_cleanup_uncertain");
        const reset = await config.runner.run(
          config.systemctlExecutable,
          ["reset-failed", unit],
          { timeoutMs: 2_000 },
        );
        const after = await config.runner.run(
          config.systemctlExecutable,
          [
            "show",
            unit,
            "--property=ActiveState,ControlGroup,LoadState",
            "--no-pager",
          ],
          { timeoutMs: 2_000 },
        );
        if (reset.code !== 0 && !unitAbsent(after))
          throw new Error("systemd_unit_cleanup_uncertain");
        if (!unitInactiveOrAbsent(after))
          throw new Error("systemd_unit_cleanup_uncertain");
      };
      await config.ledger.finalize(prepared.recordId, record.observed, cleanup);
    },
  });
}
