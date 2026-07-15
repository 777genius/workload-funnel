import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  encodePressureFixtureReadiness,
  parsePressureFixtureReadiness,
  pressureFixturePrimedState,
  PRESSURE_FIXTURE_MEMORY_TARGET,
  PRESSURE_FIXTURE_MODES,
} from "./pressure-fixture-protocol.mjs";
import {
  runPressureAdmissionStage,
  waitForPressureFixtureReadiness,
} from "./pressure-stage.mjs";

function fixtures(runtimeDeadlineMs = 100_000) {
  return PRESSURE_FIXTURE_MODES.map((mode) => ({
    mode,
    process: Object.freeze({ mode }),
    runtimeDeadlineMs,
  }));
}

function missingReady() {
  return Promise.reject(
    Object.assign(new Error("not ready"), { code: "ENOENT" }),
  );
}

describe("pressure fixture priming and bounded lifetime", () => {
  it("keeps the memory fixture and strict protocol on one 22 x 16 MiB target", async () => {
    expect(PRESSURE_FIXTURE_MEMORY_TARGET).toStrictEqual({
      chunkBytes: 16 * 1024 * 1024,
      chunkCount: 22,
      retainedBytes: 352 * 1024 * 1024,
    });
    expect(Object.isFrozen(PRESSURE_FIXTURE_MEMORY_TARGET)).toBe(true);
    expect(pressureFixturePrimedState("memory")).toStrictEqual({
      retainedBytes: PRESSURE_FIXTURE_MEMORY_TARGET.retainedBytes,
    });

    const fixtureSource = await readFile(
      new URL("./fixtures/pressure-load.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).toContain(
      "index < PRESSURE_FIXTURE_MEMORY_TARGET.chunkCount",
    );
    expect(fixtureSource).toContain(
      "Buffer.alloc(PRESSURE_FIXTURE_MEMORY_TARGET.chunkBytes, 1)",
    );

    expect(() =>
      parsePressureFixtureReadiness(
        JSON.stringify({
          mode: "memory",
          primed: { retainedBytes: 28 * 16 * 1024 * 1024 },
          schemaVersion: "workload-funnel.production-gate.pressure-ready.v1",
        }),
        "memory",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
  });

  it("accepts only each mode's exact primed-state marker", () => {
    for (const mode of PRESSURE_FIXTURE_MODES)
      expect(
        parsePressureFixtureReadiness(
          encodePressureFixtureReadiness(mode),
          mode,
        ),
      ).toMatchObject({ mode, primed: expect.any(Object) });

    expect(() =>
      parsePressureFixtureReadiness(
        '{"mode":"io","primed":{"syncedBytes":1},"schemaVersion":"workload-funnel.production-gate.pressure-ready.v1"}\n',
        "io",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
    expect(() =>
      parsePressureFixtureReadiness(
        encodePressureFixtureReadiness("memory"),
        "cpu",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
  });

  it("fails closed when a readiness marker stays missing", async () => {
    let now = 0;
    const verifyRunning = vi.fn();
    await expect(
      waitForPressureFixtureReadiness({
        clock: () => now,
        fixtures: fixtures(),
        readReady: missingReady,
        root: "/synthetic/pressure",
        timeoutMs: 10_000,
        verifyRunning,
        wait: (milliseconds) => {
          now += milliseconds;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("pressure_fixture_readiness_timeout");
    expect(verifyRunning).not.toHaveBeenCalled();
  });

  it("rejects an expired unit before trusting a marker or identity", async () => {
    const readReady = vi.fn();
    const verifyRunning = vi.fn();
    await expect(
      waitForPressureFixtureReadiness({
        clock: () => 50_000,
        fixtures: fixtures(50_000),
        readReady,
        root: "/synthetic/pressure",
        verifyRunning,
        wait: () => Promise.resolve(),
      }),
    ).rejects.toThrow("pressure_fixture_runtime_expired");
    expect(readReady).not.toHaveBeenCalled();
    expect(verifyRunning).not.toHaveBeenCalled();
  });
});

function pressureStageHarness(uncertainMode) {
  let now = 0;
  const started = [];
  const stopped = [];
  const fileSystem = {
    chown: vi.fn(() => Promise.resolve()),
    mkdir: vi.fn(() => Promise.resolve()),
    readFile: vi.fn(missingReady),
    rm: vi.fn(() => Promise.resolve()),
  };
  const processManager = {
    cancel: vi.fn(),
    start: vi.fn((_executable, _arguments, role, options) => {
      started.push({ options, role });
      now += 1_000;
      return Promise.resolve(
        Object.freeze({
          controlGroup: `/synthetic/${role}`,
          invocationId: role,
          role,
          runtimeMaxSec: options?.runtimeMaxSec ?? 30,
          unit: `${role}.service`,
        }),
      );
    }),
    stop: vi.fn((process) => {
      stopped.push(process.role);
      if (process.role === `pressure-${uncertainMode}`)
        return Promise.reject(new Error("bounded_host_process_stop_uncertain"));
      return Promise.resolve();
    }),
    verify: vi.fn(),
  };
  const operation = runPressureAdmissionStage({
    allocation: { gid: 1000, root: "/synthetic/allocation", uid: 1000 },
    clock: () => now,
    config: {
      nodeExecutable: "/usr/bin/node",
      sandboxRoot: "/synthetic/sandbox",
    },
    fileSystem,
    postgres: {},
    processManager,
    runner: {},
    runtimeClock: () => now,
    systemdCapabilityEvidence: {
      cgroupV2Controllers: ["cpu", "io", "memory", "pids"],
      nonMutatingVerification: true,
    },
    wait: (milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    },
  });
  return { fileSystem, operation, processManager, started, stopped };
}

describe("pressure stage failure cleanup", () => {
  it("stops every exact bounded fixture and removes the root after missing readiness", async () => {
    const harness = pressureStageHarness();
    await expect(harness.operation).rejects.toThrow(
      "pressure_fixture_readiness_timeout",
    );
    expect(harness.stopped).toEqual(
      PRESSURE_FIXTURE_MODES.map((mode) => `pressure-${mode}`),
    );
    expect(harness.fileSystem.rm).toHaveBeenCalledOnce();
    expect(harness.processManager.cancel).not.toHaveBeenCalled();
    expect(harness.started).toEqual(
      PRESSURE_FIXTURE_MODES.map((mode) => ({
        options: { runtimeMaxSec: 75 },
        role: `pressure-${mode}`,
      })),
    );
  });

  it("attempts every fixture stop, retains the root, and reports uncertain cleanup", async () => {
    const harness = pressureStageHarness("io");
    await expect(harness.operation).rejects.toThrow(
      "bounded_host_process_stop_uncertain",
    );
    expect(harness.stopped).toEqual(
      PRESSURE_FIXTURE_MODES.map((mode) => `pressure-${mode}`),
    );
    expect(harness.fileSystem.rm).not.toHaveBeenCalled();
  });
});
