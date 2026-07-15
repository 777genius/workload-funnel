function unitAbsent(result) {
  return (
    result.stdout.trim() === "LoadState=not-found" ||
    (result.code !== 0 &&
      /(?:could not be found|not found|not loaded)/iu.test(result.stderr))
  );
}

function unitInactiveOrAbsent(result) {
  return (
    unitAbsent(result) ||
    (result.code === 0 &&
      result.stdout.includes("ActiveState=inactive") &&
      result.stdout.includes("ControlGroup=\n"))
  );
}

export async function cleanupSystemdSlice(config, record) {
  const before = await config.runner.run(
    config.systemctlExecutable,
    ["show", record.name, "--property=ControlGroup,LoadState", "--no-pager"],
    { timeoutMs: 2_000 },
  );
  if (unitAbsent(before)) return;
  if (
    before.code !== 0 ||
    (record.observed.controlGroup !== undefined &&
      !before.stdout.includes(`ControlGroup=${record.observed.controlGroup}\n`))
  )
    throw new Error("systemd_slice_cleanup_identity_changed");
  const stopped = await config.runner.run(
    config.systemctlExecutable,
    ["stop", record.name],
    { timeoutMs: 2_000 },
  );
  if (stopped.code !== 0) throw new Error("systemd_slice_cleanup_uncertain");
  await config.runner.run(
    config.systemctlExecutable,
    ["reset-failed", record.name],
    { timeoutMs: 2_000 },
  );
  const after = await config.runner.run(
    config.systemctlExecutable,
    [
      "show",
      record.name,
      "--property=ActiveState,ControlGroup,LoadState",
      "--no-pager",
    ],
    { timeoutMs: 2_000 },
  );
  if (!unitInactiveOrAbsent(after))
    throw new Error("systemd_slice_cleanup_uncertain");
}

export function createSystemdSliceOwnership(config) {
  let recordId;
  let registered = false;
  const slice = `${config.runId}.slice`;
  return Object.freeze({
    async admit() {
      if (recordId !== undefined || registered) return;
      const observed = await config.runner.run(
        config.systemctlExecutable,
        ["show", slice, "--property=LoadState", "--no-pager"],
        { timeoutMs: 2_000 },
      );
      if (!unitAbsent(observed))
        throw new Error("systemd_gate_slice_already_exists_or_unprovable");
      recordId = await config.ledger.prepare("systemd-slice", slice, {
        controlGroup: `/${slice}`,
      });
    },
    async register() {
      if (recordId === undefined)
        throw new Error("systemd_gate_slice_ownership_not_admitted");
      if (registered) return;
      const observed = await config.runner.run(
        config.systemctlExecutable,
        ["show", slice, "--property=ControlGroup,LoadState", "--no-pager"],
        { timeoutMs: 2_000 },
      );
      const controlGroup = observed.stdout.match(/^ControlGroup=(\S+)$/mu)?.[1];
      if (
        observed.code !== 0 ||
        typeof controlGroup !== "string" ||
        !controlGroup.endsWith(`/${slice}`)
      )
        throw new Error("systemd_gate_slice_identity_unproven");
      const record = Object.freeze({
        expected: { controlGroup: `/${slice}` },
        name: slice,
        observed: { controlGroup },
      });
      await config.ledger.finalize(recordId, record.observed, () =>
        cleanupSystemdSlice(config, record),
      );
      registered = true;
    },
  });
}
