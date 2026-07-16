import { chown, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

import { observeHost } from "./host-observation.mjs";
import {
  monotonicMilliseconds,
  runMixedWorkloadMeasurement,
} from "./mixed-load.mjs";
import {
  parsePressureFixtureReadiness,
  PRESSURE_FIXTURE_MODES,
} from "./pressure-fixture-protocol.mjs";
import { atomicAcceptanceSql, psqlArguments } from "./postgres-probe.mjs";

const pressureFixturePath = fileURLToPath(
  new URL("./fixtures/pressure-load.mjs", import.meta.url),
);
const PRESSURE_FIXTURE_RUNTIME_MAX_SEC = 75;
const PRESSURE_MEASUREMENT_DURATION_MS = 30_000;
const PRESSURE_MINIMUM_RUNTIME_REMAINING_MS = 40_000;
const defaultFileSystem = Object.freeze({ chown, mkdir, readFile, rm });

async function psql(runner, config, sql, timeoutMs = 5_000) {
  return runner.run(config.psqlExecutable, psqlArguments({ ...config, sql }), {
    environment: { PGPASSWORD: config.password },
    timeoutMs,
  });
}

export async function waitForPressureFixtureReadiness({
  clock = Date.now,
  fixtures,
  minimumRuntimeRemainingMs = PRESSURE_MINIMUM_RUNTIME_REMAINING_MS,
  readReady = readFile,
  root,
  timeoutMs = 25_000,
  verifyRunning,
  wait,
}) {
  const modes = Array.isArray(fixtures)
    ? fixtures.map((fixture) => fixture?.mode)
    : undefined;
  if (
    !/^\/[A-Za-z0-9_./-]+$/u.test(root) ||
    !Array.isArray(fixtures) ||
    fixtures.length !== PRESSURE_FIXTURE_MODES.length ||
    fixtures.some(
      (fixture, index) =>
        fixture === null ||
        typeof fixture !== "object" ||
        fixture.mode !== PRESSURE_FIXTURE_MODES[index] ||
        fixture.process === null ||
        typeof fixture.process !== "object" ||
        !Number.isFinite(fixture.runtimeDeadlineMs),
    ) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 10_000 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(minimumRuntimeRemainingMs) ||
    minimumRuntimeRemainingMs < PRESSURE_MEASUREMENT_DURATION_MS ||
    minimumRuntimeRemainingMs > 60_000 ||
    typeof readReady !== "function" ||
    typeof verifyRunning !== "function" ||
    typeof wait !== "function"
  )
    throw new Error("pressure_fixture_readiness_input_invalid");
  const startedAtMs = clock();
  if (!Number.isFinite(startedAtMs))
    throw new Error("pressure_fixture_readiness_input_invalid");
  for (;;) {
    const nowMs = clock();
    if (!Number.isFinite(nowMs))
      throw new Error("pressure_fixture_readiness_input_invalid");
    const remaining = fixtures.map(
      (fixture) => fixture.runtimeDeadlineMs - nowMs,
    );
    if (remaining.some((duration) => duration <= 0))
      throw new Error("pressure_fixture_runtime_expired");
    if (remaining.some((duration) => duration < minimumRuntimeRemainingMs))
      throw new Error("pressure_fixture_runtime_budget_insufficient");
    const results = await Promise.all(
      fixtures.map(async (fixture) => {
        try {
          return parsePressureFixtureReadiness(
            await readReady(`${root}/.ready-${fixture.mode}`, "utf8"),
            fixture.mode,
          );
        } catch (error) {
          if (error?.code === "ENOENT") return undefined;
          throw error;
        }
      }),
    );
    if (results.every((result) => result !== undefined)) {
      const verifiedFixtures = await Promise.all(
        fixtures.map(async (fixture, index) =>
          Object.freeze({
            mode: fixture.mode,
            primed: results[index].primed,
            process: await verifyRunning(fixture.process, fixture.mode),
          }),
        ),
      );
      const completedAtMs = clock();
      if (!Number.isFinite(completedAtMs))
        throw new Error("pressure_fixture_readiness_input_invalid");
      const completedRemaining = fixtures.map(
        (fixture) => fixture.runtimeDeadlineMs - completedAtMs,
      );
      if (completedRemaining.some((duration) => duration <= 0))
        throw new Error("pressure_fixture_runtime_expired");
      if (
        completedRemaining.some(
          (duration) => duration < minimumRuntimeRemainingMs,
        )
      )
        throw new Error("pressure_fixture_runtime_budget_insufficient");
      return Object.freeze({
        allModesReady: true,
        durationMs: completedAtMs - startedAtMs,
        minimumRuntimeRemainingMs: Math.min(...completedRemaining),
        modes: Object.freeze([...modes]),
        verifiedFixtures: Object.freeze(verifiedFixtures),
      });
    }
    if (clock() - startedAtMs >= timeoutMs)
      throw new Error("pressure_fixture_readiness_timeout");
    await wait(50);
  }
}

export async function runPressureAdmissionStage({
  allocation,
  clock = Date.now,
  config,
  fileSystem = defaultFileSystem,
  postgres,
  processManager,
  runner,
  runtimeClock = monotonicMilliseconds,
  systemdCapabilityEvidence,
  systemdEvidence,
  wait,
}) {
  if (postgres === undefined)
    throw new Error("postgres_fixture_required_for_mixed_load");
  if (
    systemdCapabilityEvidence?.systemdPropertyVerificationNonMutating !==
      true ||
    systemdCapabilityEvidence?.projectQuotaMutatingProbe !== true ||
    systemdCapabilityEvidence?.projectQuota?.receipt === undefined ||
    !["cpu", "io", "memory", "pids"].every((controller) =>
      systemdCapabilityEvidence.cgroupV2Controllers?.includes(controller),
    )
  )
    throw new Error("systemd_capability_required_for_mixed_load");
  if (
    !["chown", "mkdir", "readFile", "rm"].every(
      (operation) => typeof fileSystem?.[operation] === "function",
    ) ||
    typeof clock !== "function" ||
    typeof runtimeClock !== "function"
  )
    throw new Error("pressure_stage_configuration_invalid");
  const pressureRoot = `${allocation.root}/pressure`;
  await fileSystem.mkdir(pressureRoot, { mode: 0o700 });
  await fileSystem.chown(pressureRoot, allocation.uid, allocation.gid);
  let cancellationProbe;
  let confinedCancellationEvidence;
  let pressureReadiness;
  const pressureFixtures = [];
  let pressureQuiescedAfterPause = false;
  let pressureStopPromise;
  const stopPressure = async () => {
    pressureStopPromise ??= (async () => {
      const outcomes = await Promise.allSettled(
        pressureFixtures.map((fixture) => processManager.stop(fixture.process)),
      );
      const failure = outcomes.find((outcome) => outcome.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      await fileSystem.rm(pressureRoot, { force: true, recursive: true });
    })();
    return pressureStopPromise;
  };
  let measurement;
  let stageFailure;
  try {
    for (const mode of PRESSURE_FIXTURE_MODES) {
      const startedAtMs = runtimeClock();
      const process = await processManager.start(
        config.nodeExecutable,
        [pressureFixturePath, mode, pressureRoot],
        `pressure-${mode}`,
        { runtimeMaxSec: PRESSURE_FIXTURE_RUNTIME_MAX_SEC },
      );
      pressureFixtures.push(
        Object.freeze({
          mode,
          process,
          runtimeDeadlineMs:
            startedAtMs + PRESSURE_FIXTURE_RUNTIME_MAX_SEC * 1_000,
        }),
      );
      if (process.runtimeMaxSec !== PRESSURE_FIXTURE_RUNTIME_MAX_SEC)
        throw new Error("pressure_fixture_runtime_profile_unproven");
    }
    measurement = await runMixedWorkloadMeasurement({
      clock,
      durationMs: PRESSURE_MEASUREMENT_DURATION_MS,
      maximumIterations: 900,
      maximumSamples: 256,
      onAbort: stopPressure,
      onPause: async () => {
        await stopPressure();
        pressureQuiescedAfterPause = true;
      },
      prepare: async () => {
        pressureReadiness = await waitForPressureFixtureReadiness({
          clock: runtimeClock,
          fixtures: pressureFixtures,
          readReady: fileSystem.readFile,
          root: pressureRoot,
          verifyRunning: (process) => processManager.verify(process),
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
          pressureCgroups: pressureFixtures.map(
            (fixture) => fixture.process.controlGroup,
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
  } catch (error) {
    stageFailure = error;
  }
  let cleanupFailure;
  try {
    await stopPressure();
  } catch (error) {
    cleanupFailure = error;
  }
  if (cancellationProbe !== undefined) {
    try {
      const evidence = await processManager.cancel(cancellationProbe);
      if (evidence.confinedCancellationPerformed)
        confinedCancellationEvidence = evidence;
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (stageFailure !== undefined) throw stageFailure;
  const evidence = Object.freeze({
    ...measurement,
    boundedSystemdConfinementObserved: true,
    confinedCancellationEvidence: confinedCancellationEvidence ?? null,
    pressureModes: PRESSURE_FIXTURE_MODES,
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
      evidence.pressureReadiness.minimumRuntimeRemainingMs >=
        PRESSURE_MINIMUM_RUNTIME_REMAINING_MS &&
      evidence.pressureReadiness.verifiedFixtures.length ===
        PRESSURE_FIXTURE_MODES.length &&
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
