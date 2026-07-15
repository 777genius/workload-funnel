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

const SLICE_SHOW_PROPERTIES = Object.freeze([
  "ActiveState",
  "ControlGroup",
  "Description",
  "DropInPaths",
  "FragmentPath",
  "Id",
  "LoadState",
  "Names",
  "SourcePath",
  "Transient",
]);

function parseSliceShow(result) {
  if (result.code !== 0) return undefined;
  const values = {};
  const expected = new Set(SLICE_SHOW_PROPERTIES);
  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  for (const line of lines) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !expected.has(key) || Object.hasOwn(values, key))
      return undefined;
    values[key] = line.slice(separator + 1);
  }
  if (Object.keys(values).length !== SLICE_SHOW_PROPERTIES.length)
    return undefined;
  return values;
}

function unconfiguredSliceIdentity(values, slice) {
  const unitName = slice.match(
    /^(wf-production-gate-[a-f0-9]{32})\.slice$/u,
  )?.[1];
  const implicitDescription =
    unitName === undefined
      ? undefined
      : `Slice /${unitName.replaceAll("-", "/")}`;
  return (
    values?.Description === implicitDescription &&
    values.DropInPaths === "" &&
    values.FragmentPath === "" &&
    values.Id === slice &&
    values.LoadState === "loaded" &&
    values.Names === slice &&
    values.SourcePath === "" &&
    values.Transient === "no"
  );
}

function implicitSliceBaseline(result, slice) {
  const values = parseSliceShow(result);
  return (
    unconfiguredSliceIdentity(values, slice) &&
    values.ActiveState === "inactive" &&
    values.ControlGroup === ""
  );
}

function showSlice(config, slice) {
  return config.runner.run(
    config.systemctlExecutable,
    [
      "show",
      slice,
      `--property=${SLICE_SHOW_PROPERTIES.join(",")}`,
      "--no-pager",
    ],
    { timeoutMs: 2_000 },
  );
}

export async function cleanupSystemdSlice(config, record) {
  const before = await showSlice(config, record.name);
  if (unitAbsent(before) || implicitSliceBaseline(before, record.name)) return;
  const beforeValues = parseSliceShow(before);
  if (
    !unconfiguredSliceIdentity(beforeValues, record.name) ||
    typeof record.observed.controlGroup !== "string" ||
    record.observed.controlGroup.length === 0 ||
    beforeValues.ControlGroup !== record.observed.controlGroup
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
  const after = await showSlice(config, record.name);
  if (!unitAbsent(after) && !implicitSliceBaseline(after, record.name))
    throw new Error("systemd_slice_cleanup_uncertain");
}

export function createSystemdSliceOwnership(config) {
  let recordId;
  let registered = false;
  const slice = `${config.runId}.slice`;
  return Object.freeze({
    async admit() {
      if (recordId !== undefined || registered) return;
      const observed = await showSlice(config, slice);
      if (!unitAbsent(observed) && !implicitSliceBaseline(observed, slice))
        throw new Error("systemd_gate_slice_already_exists_or_unprovable");
      recordId = await config.ledger.prepare("systemd-slice", slice, {
        controlGroup: `/${slice}`,
      });
    },
    async register() {
      if (recordId === undefined)
        throw new Error("systemd_gate_slice_ownership_not_admitted");
      if (registered) return;
      const observed = await showSlice(config, slice);
      const values = parseSliceShow(observed);
      const controlGroup = values?.ControlGroup;
      if (
        !unconfiguredSliceIdentity(values, slice) ||
        typeof controlGroup !== "string" ||
        controlGroup.length === 0 ||
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
