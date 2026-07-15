import { chown, mkdir, rm } from "node:fs/promises";
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
  let cancelSequence = 0;
  const pressureProcesses = [];
  const pressureModes = Object.freeze([
    "cpu",
    "memory",
    "io",
    "disk",
    "inodes",
  ]);
  let pressureStopped = false;
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
      maximumIterations: 256,
      onAbort: stopPressure,
      onPause: stopPressure,
      policy: Object.freeze({
        ...DEFAULT_PRESSURE_POLICY,
        highObservationsToPause: 20,
      }),
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
          cancelSequence += 1;
          const process = await processManager.start(
            config.nodeExecutable,
            ["-e", "setInterval(() => {}, 1000)"],
            `cancel-${String(cancelSequence)}`,
          );
          await processManager.stop(process);
          return true;
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
  }
  const evidence = Object.freeze({
    ...measurement,
    boundedSystemdConfinementObserved: true,
    pressureModes,
    systemdCapabilityEvidence,
    systemdResourceProbe: systemdEvidence ?? null,
  });
  return Object.freeze({
    complete:
      evidence.slo.passed &&
      evidence.observedPause &&
      evidence.observedReopen &&
      !evidence.abortedBeforeHostExhaustion &&
      evidence.maximumObserved.gateDiskUsedRatio >= 0.7 &&
      evidence.maximumObserved.gateInodeUsedRatio >= 0.7 &&
      evidence.maximumObserved.workloadCpuPsiSome > 0 &&
      evidence.maximumObserved.workloadIoPsiSome > 0 &&
      evidence.maximumObserved.workloadMemoryPsiSome > 0,
    evidence,
  });
}
