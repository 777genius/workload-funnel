import { access, chown, mkdir, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { observeHost } from "./host-observation.mjs";
import {
  monotonicMilliseconds,
  runMixedWorkloadMeasurement,
} from "./mixed-load.mjs";
import { DEFAULT_PRESSURE_POLICY } from "./pressure.mjs";
import { atomicAcceptanceSql, psqlArguments } from "./postgres-probe.mjs";

const pressureFixturePath = fileURLToPath(
  new URL("./fixtures/pressure-load.mjs", import.meta.url),
);

async function psql(runner, config, sql, timeoutMs = 5_000) {
  return runner.run(config.psqlExecutable, psqlArguments({ ...config, sql }), {
    environment: { PGPASSWORD: config.password },
    timeoutMs,
  });
}

export async function waitForPressureFixtureReadiness({
  clock = Date.now,
  modes,
  ready = access,
  root,
  timeoutMs = 25_000,
  wait,
}) {
  if (
    !/^\/[A-Za-z0-9_./-]+$/u.test(root) ||
    !Array.isArray(modes) ||
    modes.length === 0 ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !/^[a-z]+$/u.test(mode)) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10_000 ||
    timeoutMs > 30_000 ||
    typeof ready !== "function" ||
    typeof wait !== "function"
  )
    throw new Error("pressure_fixture_readiness_input_invalid");
  const startedAtMs = clock();
  const paths = modes.map((mode) => `${root}/.ready-${mode}`);
  for (;;) {
    const results = await Promise.all(
      paths.map(async (path) => {
        try {
          await ready(path);
          return true;
        } catch (error) {
          if (error?.code === "ENOENT") return false;
          throw error;
        }
      }),
    );
    if (results.every(Boolean))
      return Object.freeze({
        allModesReady: true,
        durationMs: clock() - startedAtMs,
        modes: Object.freeze([...modes]),
      });
    if (clock() - startedAtMs >= timeoutMs)
      throw new Error("pressure_fixture_readiness_timeout");
    await wait(50);
  }
}

export async function runPressureAdmissionStage({
  allocation,
  config,
  postgres,
  processManager,
  runner,
  systemdCapabilityEvidence,
  systemdEvidence,
  wait,
}) {
  if (postgres === undefined)
    throw new Error("postgres_fixture_required_for_mixed_load");
  if (
    systemdCapabilityEvidence?.nonMutatingVerification !== true ||
    !["cpu", "io", "memory", "pids"].every((controller) =>
      systemdCapabilityEvidence.cgroupV2Controllers?.includes(controller),
    )
  )
    throw new Error("systemd_capability_required_for_mixed_load");
  const pressureRoot = `${allocation.root}/pressure`;
  await mkdir(pressureRoot, { mode: 0o700 });
  await chown(pressureRoot, allocation.uid, allocation.gid);
  let cancellationProbe;
  let confinedCancellationEvidence;
  let pressureReadiness;
  const pressureProcesses = [];
  const pressureModes = Object.freeze([
    "cpu",
    "memory",
    "io",
    "disk",
    "inodes",
  ]);
  let pressureStopped = false;
  let pressureQuiescedAfterPause = false;
  const stopPressure = async () => {
    if (pressureStopped) return;
    pressureStopped = true;
    await Promise.all(
      pressureProcesses.map((process) => processManager.stop(process)),
    );
    await rm(pressureRoot, { force: true, recursive: true });
  };
  let measurement;
  try {
    for (const mode of pressureModes)
      pressureProcesses.push(
        await processManager.start(
          config.nodeExecutable,
          [pressureFixturePath, mode, pressureRoot],
          `pressure-${mode}`,
        ),
      );
    measurement = await runMixedWorkloadMeasurement({
      clock: Date.now,
      durationMs: 30_000,
      maximumIterations: 900,
      maximumSamples: 256,
      onAbort: stopPressure,
      onPause: async () => {
        await stopPressure();
        pressureQuiescedAfterPause = true;
      },
      policy: Object.freeze({
        ...DEFAULT_PRESSURE_POLICY,
        highObservationsToPause: 20,
      }),
      prepare: async () => {
        pressureReadiness = await waitForPressureFixtureReadiness({
          modes: pressureModes,
          root: pressureRoot,
          wait,
        });
        cancellationProbe = await processManager.start(
          config.nodeExecutable,
          ["-e", "setInterval(() => {}, 1000)"],
          "cancel-probe",
        );
      },
      observe: () =>
        observeHost({
          gateStorage: {
            maximumBytes: 64 * 1024 * 1024,
            maximumInodes: 4_096,
            root: pressureRoot,
          },
          pressureCgroups: pressureProcesses.map(
            (process) => process.controlGroup,
          ),
          sandboxRoot: config.sandboxRoot,
        }),
      preciseClock: monotonicMilliseconds,
      produce: async (index) => {
        const id = `load-${String(index)}`;
        const result = await psql(
          runner,
          postgres,
          atomicAcceptanceSql({
            callerScope: "load",
            idempotencyKey: id,
            operationId: id,
            schema: postgres.schema,
            workloadId: id,
          }),
        );
        return result.code === 0;
      },
      protectedControls: {
        cancel: async () => {
          const evidence = await processManager.cancel(cancellationProbe);
          if (evidence.confinedCancellationPerformed)
            confinedCancellationEvidence = evidence;
          return evidence.cancellationObserved;
        },
        health: async () =>
          (await psql(runner, postgres, "SELECT 1;")).code === 0,
        status: async () =>
          (
            await psql(
              runner,
              postgres,
              "SELECT count(*) FROM pg_stat_activity;",
            )
          ).code === 0,
      },
      wait,
    });
  } finally {
    await stopPressure();
    if (cancellationProbe !== undefined) {
      const evidence = await processManager.cancel(cancellationProbe);
      if (evidence.confinedCancellationPerformed)
        confinedCancellationEvidence = evidence;
    }
  }
  const evidence = Object.freeze({
    ...measurement,
    boundedSystemdConfinementObserved: true,
    confinedCancellationEvidence: confinedCancellationEvidence ?? null,
    pressureModes,
    pressureReadiness,
    pressureQuiescedAfterPause,
    realConfinedCancellationObserved:
      confinedCancellationEvidence?.confinedCancellationPerformed === true,
    systemdCapabilityEvidence,
    systemdResourceProbe: systemdEvidence ?? null,
  });
  return Object.freeze({
    complete:
      evidence.slo.passed &&
      evidence.acceptedAfterReopen > 0 &&
      evidence.observedPause &&
      evidence.observedReopen &&
      evidence.pressureQuiescedAfterPause &&
      evidence.realConfinedCancellationObserved &&
      evidence.pressureReadiness?.allModesReady === true &&
      evidence.sampleCounts.cancel >= 100 &&
      evidence.sampleCounts.health >= 100 &&
      evidence.sampleCounts.status >= 100 &&
      !evidence.abortedBeforeHostExhaustion &&
      evidence.maximumObserved.gateDiskUsedRatio >= 0.7 &&
      evidence.maximumObserved.gateInodeUsedRatio >= 0.7 &&
      evidence.maximumObserved.workloadCpuPsiSome > 0 &&
      evidence.maximumObserved.workloadIoPsiSome > 0 &&
      evidence.maximumObserved.workloadMemoryPsiSome > 0,
    evidence,
  });
}
