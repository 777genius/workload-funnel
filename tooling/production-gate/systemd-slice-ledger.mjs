import { performance } from "node:perf_hooks";
import { setTimeout as wait } from "node:timers/promises";

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

function ownedSliceControlGroup(value, slice) {
  return (
    typeof value === "string" &&
    /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(value) &&
    value.startsWith("/wf.slice/wf-production.slice/") &&
    value.endsWith(`/${slice}`)
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

const SLICE_CLEANUP_POLL_INTERVAL_MS = 50;
const SLICE_CLEANUP_POLL_MAXIMUM_MS = 1_000;

async function observeStoppedSlice(config, slice, controlGroup) {
  const clock = config.clock ?? (() => performance.now());
  const pause = config.wait ?? wait;
  const deadline = clock() + SLICE_CLEANUP_POLL_MAXIMUM_MS;
  for (;;) {
    const observed = await showSlice(config, slice);
    if (implicitSliceBaseline(observed, slice)) {
      if (clock() > deadline)
        throw new Error("systemd_slice_cleanup_uncertain");
      return;
    }
    const values = parseSliceShow(observed);
    if (observed.code !== 0 || values === undefined)
      throw new Error("systemd_slice_cleanup_uncertain");
    if (
      !unconfiguredSliceIdentity(values, slice) ||
      values.ActiveState !== "active" ||
      values.ControlGroup !== controlGroup
    )
      throw new Error("systemd_slice_cleanup_identity_changed");
    if (clock() >= deadline) throw new Error("systemd_slice_cleanup_uncertain");
    await pause(SLICE_CLEANUP_POLL_INTERVAL_MS);
  }
}

export async function cleanupSystemdSlice(config, record) {
  const before = await showSlice(config, record.name);
  if (unitAbsent(before) || implicitSliceBaseline(before, record.name)) return;
  const beforeValues = parseSliceShow(before);
  const finalizedControlGroup = record.observed.controlGroup;
  const preparedOnly =
    Object.keys(record.observed).length === 0 &&
    record.expected?.controlGroupSuffix === `/${record.name}`;
  if (
    !unconfiguredSliceIdentity(beforeValues, record.name) ||
    beforeValues.ActiveState !== "active" ||
    !ownedSliceControlGroup(beforeValues.ControlGroup, record.name) ||
    (typeof finalizedControlGroup === "string"
      ? !ownedSliceControlGroup(finalizedControlGroup, record.name) ||
        finalizedControlGroup !== beforeValues.ControlGroup
      : !preparedOnly)
  )
    throw new Error("systemd_slice_cleanup_identity_changed");
  const stopped = await config.runner.run(
    config.systemctlExecutable,
    ["stop", record.name],
    { timeoutMs: 2_000 },
  );
  if (stopped.code !== 0) throw new Error("systemd_slice_cleanup_uncertain");
  const afterStop = await showSlice(config, record.name);
  if (implicitSliceBaseline(afterStop, record.name)) return;
  const afterStopValues = parseSliceShow(afterStop);
  if (
    afterStop.code !== 0 ||
    !unconfiguredSliceIdentity(afterStopValues, record.name) ||
    afterStopValues.ActiveState !== "active" ||
    afterStopValues.ControlGroup !== beforeValues.ControlGroup
  )
    throw new Error("systemd_slice_cleanup_identity_changed");
  const reset = await config.runner.run(
    config.systemctlExecutable,
    ["reset-failed", record.name],
    { timeoutMs: 2_000 },
  );
  if (reset.code !== 0) {
    const afterFailedReset = await showSlice(config, record.name);
    if (implicitSliceBaseline(afterFailedReset, record.name)) return;
    throw new Error("systemd_slice_cleanup_uncertain");
  }
  await observeStoppedSlice(config, record.name, beforeValues.ControlGroup);
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
        controlGroupSuffix: `/${slice}`,
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
        !ownedSliceControlGroup(controlGroup, slice)
      )
        throw new Error("systemd_gate_slice_identity_unproven");
      const record = Object.freeze({
        expected: { controlGroupSuffix: `/${slice}` },
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
