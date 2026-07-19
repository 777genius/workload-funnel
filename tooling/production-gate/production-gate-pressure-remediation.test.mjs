import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { runMixedWorkloadMeasurement } from "./mixed-load.mjs";
import {
  encodePressureFixtureReadiness,
  parsePressureFixtureReadiness,
  primeIoPressureFixture,
  pressureFixturePrimedState,
  runMemoryPressureFixture,
  PRESSURE_FIXTURE_CPU_WORKER_COUNT,
  PRESSURE_FIXTURE_DISK_TARGET_BYTES,
  PRESSURE_FIXTURE_IO_TARGET_BYTES,
  PRESSURE_FIXTURE_MEMORY_TARGET,
  PRESSURE_FIXTURE_MODES,
  PRESSURE_FIXTURE_READY_SCHEMA,
} from "./pressure-fixture-protocol.mjs";
import {
  runPressureAdmissionStage,
  waitForPressureFixtureReadiness,
} from "./pressure-stage.mjs";
import {
  SYSTEMD_GATE_PROJECT_QUOTA_BYTES,
  SYSTEMD_IO_PROBE_MAX_BYTES,
} from "./systemd-contract.mjs";

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
  it("performs one exact IO sync before readiness without a tight steady-state loop", async () => {
    const events = [];
    await primeIoPressureFixture({
      markReady: async () => events.push("ready"),
      writeCycle: async () => events.push("write"),
    });
    expect(events).toStrictEqual(["write", "ready"]);

    const fixtureSource = await readFile(
      new URL("./fixtures/pressure-load.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).toContain("primeIoPressureFixture");
    expect(fixtureSource).not.toContain("for (;;) await writeCycle()");
  });

  it("uses the protocol-owned exact two-worker CPU target", async () => {
    expect(PRESSURE_FIXTURE_CPU_WORKER_COUNT).toBe(2);
    expect(pressureFixturePrimedState("cpu")).toStrictEqual({
      workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT,
    });
    expect(
      parsePressureFixtureReadiness(
        JSON.stringify({
          mode: "cpu",
          primed: { workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT },
          schemaVersion: PRESSURE_FIXTURE_READY_SCHEMA,
        }),
        "cpu",
      ),
    ).toStrictEqual({
      mode: "cpu",
      primed: { workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT },
      schemaVersion: PRESSURE_FIXTURE_READY_SCHEMA,
    });

    const fixtureSource = await readFile(
      new URL("./fixtures/pressure-load.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).toContain(
      "length: PRESSURE_FIXTURE_CPU_WORKER_COUNT",
    );
  });

  it("rejects the former four-worker marker and non-exact CPU markers", () => {
    const readiness = (primed, extra = {}) =>
      JSON.stringify({
        mode: "cpu",
        primed,
        schemaVersion: PRESSURE_FIXTURE_READY_SCHEMA,
        ...extra,
      });

    expect(() =>
      parsePressureFixtureReadiness(readiness({ workersOnline: 4 }), "cpu"),
    ).toThrow("pressure_fixture_readiness_malformed");
    expect(() =>
      parsePressureFixtureReadiness(
        readiness({
          unexpected: true,
          workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT,
        }),
        "cpu",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
    expect(() =>
      parsePressureFixtureReadiness(
        readiness(
          { workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT },
          { unexpected: true },
        ),
        "cpu",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
  });

  it("leaves quota headroom after the preceding systemd IO probe", async () => {
    const pressurePrimedBytes =
      PRESSURE_FIXTURE_DISK_TARGET_BYTES + PRESSURE_FIXTURE_IO_TARGET_BYTES;
    const combinedBytes = pressurePrimedBytes + SYSTEMD_IO_PROBE_MAX_BYTES;

    expect(PRESSURE_FIXTURE_DISK_TARGET_BYTES).toBe(40 * 1024 * 1024);
    expect(pressurePrimedBytes).toBeGreaterThanOrEqual(
      SYSTEMD_GATE_PROJECT_QUOTA_BYTES * 0.7,
    );
    expect(combinedBytes).toBeLessThan(SYSTEMD_GATE_PROJECT_QUOTA_BYTES);
    expect(
      SYSTEMD_GATE_PROJECT_QUOTA_BYTES - combinedBytes,
    ).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    expect(pressureFixturePrimedState("disk")).toStrictEqual({
      writtenBytes: PRESSURE_FIXTURE_DISK_TARGET_BYTES,
    });
    expect(pressureFixturePrimedState("io")).toStrictEqual({
      syncedBytes: PRESSURE_FIXTURE_IO_TARGET_BYTES,
    });

    const fixtureSource = await readFile(
      new URL("./fixtures/pressure-load.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).toContain(
      "Buffer.alloc(PRESSURE_FIXTURE_DISK_TARGET_BYTES, 3)",
    );
    expect(fixtureSource).toContain(
      "offset < PRESSURE_FIXTURE_IO_TARGET_BYTES",
    );
    expect(fixtureSource).not.toContain("Buffer.alloc(48 * 1024 * 1024, 3)");
    expect(() =>
      parsePressureFixtureReadiness(
        JSON.stringify({
          mode: "disk",
          primed: { writtenBytes: 48 * 1024 * 1024 },
          schemaVersion: PRESSURE_FIXTURE_READY_SCHEMA,
        }),
        "disk",
      ),
    ).toThrow("pressure_fixture_readiness_malformed");
  });

  it("keeps exact bounded primed and post-ready memory targets", async () => {
    expect(PRESSURE_FIXTURE_MEMORY_TARGET).toStrictEqual({
      chunkBytes: 16 * 1024 * 1024,
      primedChunkCount: 22,
      primedRetainedBytes: 352 * 1024 * 1024,
      postReadyChunkCount: 25,
      postReadyRetainedBytes: 400 * 1024 * 1024,
    });
    expect(Object.isFrozen(PRESSURE_FIXTURE_MEMORY_TARGET)).toBe(true);
    expect(PRESSURE_FIXTURE_MEMORY_TARGET.primedRetainedBytes).toBeLessThan(
      384 * 1024 * 1024,
    );
    expect(
      PRESSURE_FIXTURE_MEMORY_TARGET.postReadyRetainedBytes,
    ).toBeGreaterThan(384 * 1024 * 1024);
    expect(PRESSURE_FIXTURE_MEMORY_TARGET.postReadyRetainedBytes).toBeLessThan(
      512 * 1024 * 1024,
    );
    expect(pressureFixturePrimedState("memory")).toStrictEqual({
      retainedBytes: PRESSURE_FIXTURE_MEMORY_TARGET.primedRetainedBytes,
    });

    const fixtureSource = await readFile(
      new URL("./fixtures/pressure-load.mjs", import.meta.url),
      "utf8",
    );
    expect(fixtureSource).toContain("await runMemoryPressureFixture({");
    expect(fixtureSource).toContain(
      "Buffer.alloc(PRESSURE_FIXTURE_MEMORY_TARGET.chunkBytes, 1)",
    );
    expect(fixtureSource).toContain("markReady: ready");
    expect(fixtureSource).not.toContain("28 * 16 * 1024 * 1024");

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

  it("publishes truthful readiness before bounded memory escalation", async () => {
    const events = [];
    await runMemoryPressureFixture({
      allocateChunk: (index, stage) => {
        events.push(`${stage}:${String(index)}`);
        return Promise.resolve();
      },
      markReady: () => {
        events.push("ready");
        return Promise.resolve();
      },
    });

    expect(events.slice(0, 22)).toEqual(
      Array.from({ length: 22 }, (_, index) => `primed:${String(index)}`),
    );
    expect(events[22]).toBe("ready");
    expect(events.slice(23)).toEqual([
      "post-ready:22",
      "post-ready:23",
      "post-ready:24",
    ]);
  });

  it("does not escalate memory when durable readiness publication fails", async () => {
    const allocateChunk = vi.fn(() => Promise.resolve());
    await expect(
      runMemoryPressureFixture({
        allocateChunk,
        markReady: () => Promise.reject(new Error("marker_not_durable")),
      }),
    ).rejects.toThrow("marker_not_durable");
    expect(allocateChunk).toHaveBeenCalledTimes(22);
    expect(allocateChunk).not.toHaveBeenCalledWith(
      expect.any(Number),
      "post-ready",
    );
  });

  it("keeps zero workload memory PSI fail-closed", async () => {
    const pressureStageSource = await readFile(
      new URL("./pressure-stage.mjs", import.meta.url),
      "utf8",
    );
    expect(pressureStageSource).toContain(
      "evidence.maximumObserved.workloadMemoryPsiSome > 0",
    );
    expect(pressureStageSource).not.toMatch(
      /maximumObserved\.workloadMemoryPsiSome\s*>=\s*0/u,
    );
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

describe("pressure pause escalation", () => {
  it("quiesces after two high observations before critical escalation, then reopens admissions", async () => {
    let now = 1_000;
    let observations = 0;
    let pressureQuiesced = false;
    const onAbort = vi.fn(() => Promise.resolve());
    const onPause = vi.fn(() => {
      pressureQuiesced = true;
      return Promise.resolve();
    });
    const produce = vi.fn(() => Promise.resolve(true));
    const result = await runMixedWorkloadMeasurement({
      clock: () => now,
      durationMs: 10_000,
      maximumIterations: 100,
      maximumSamples: 100,
      observe: () => {
        observations += 1;
        return Promise.resolve({
          cpuPsiSome: pressureQuiesced ? 0.01 : observations <= 2 ? 0.25 : 0.7,
          diskFreeBytes: 16 * 1024 ** 3,
          diskFreeRatio: 0.5,
          ioPsiSome: 0.01,
          loadPerCpu: 0.1,
          memoryAvailableRatio: 0.8,
          memoryPsiSome: 0.01,
          nowMs: now,
          observedAtMs: now,
        });
      },
      onAbort,
      onPause,
      preciseClock: () => now,
      produce,
      protectedControls: {
        cancel: () => Promise.resolve(true),
        health: () => Promise.resolve(true),
        status: () => Promise.resolve(true),
      },
      wait: () => {
        now += 100;
        return Promise.resolve();
      },
    });

    expect(result).toMatchObject({
      abortedBeforeHostExhaustion: false,
      observedPause: true,
      observedReopen: true,
      sampleCounts: { cancel: 100, health: 100, status: 100 },
      slo: { passed: true },
    });
    expect(onPause).toHaveBeenCalledOnce();
    expect(onAbort).not.toHaveBeenCalled();
    expect(result.acceptedAfterReopen).toBeGreaterThan(0);
    expect(produce).toHaveBeenCalled();
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
      projectQuota: { receipt: { receiptDigest: "a".repeat(64) } },
      projectQuotaMutatingProbe: true,
      systemdPropertyVerificationNonMutating: true,
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
