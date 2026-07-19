import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { setInterval, setTimeout } from "node:timers";

import {
  encodePressureFixtureReadiness,
  PRESSURE_FIXTURE_CPU_WORKER_COUNT,
  PRESSURE_FIXTURE_DISK_TARGET_BYTES,
  PRESSURE_FIXTURE_IO_TARGET_BYTES,
  PRESSURE_FIXTURE_MEMORY_TARGET,
  PRESSURE_FIXTURE_MODES,
  primeIoPressureFixture,
  runMemoryPressureFixture,
} from "../pressure-fixture-protocol.mjs";

const [mode, root] = process.argv.slice(2);
if (
  !PRESSURE_FIXTURE_MODES.includes(mode) ||
  !/^\/var\/lib\/workload-funnel\/allocations\/wf-production-gate-[a-f0-9]{32}\/pressure$/u.test(
    root ?? "",
  )
)
  process.exit(64);

await mkdir(root, { mode: 0o700, recursive: true });
const retainedMemory = [];
const retainedWorkers = [];

const ready = async () => {
  const marker = `${root}/.ready-${mode}`;
  const temporary = `${marker}.next`;
  await writeFile(temporary, encodePressureFixtureReadiness(mode), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, marker);
};

if (mode === "cpu") {
  const startWorker = () =>
    new Promise((resolve, reject) => {
      const worker = new Worker(
        'const { parentPort } = require("node:worker_threads"); parentPort.postMessage("primed"); for (;;) Math.imul(Date.now(), 17)',
        { eval: true },
      );
      worker.once("error", reject);
      worker.once("message", (message) => {
        if (message !== "primed") {
          reject(new Error("pressure_cpu_worker_priming_failed"));
          return;
        }
        resolve(worker);
      });
    });
  retainedWorkers.push(
    ...(await Promise.all(
      Array.from({ length: PRESSURE_FIXTURE_CPU_WORKER_COUNT }, startWorker),
    )),
  );
}

if (mode === "memory")
  await runMemoryPressureFixture({
    allocateChunk: async () => {
      retainedMemory.push(
        Buffer.alloc(PRESSURE_FIXTURE_MEMORY_TARGET.chunkBytes, 1),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    markReady: ready,
  });

if (mode === "io") {
  const descriptor = await open(`${root}/io-pressure.bin`, "w", 0o600);
  const block = Buffer.alloc(1024 * 1024, 2);
  const writeCycle = async () => {
    for (
      let offset = 0;
      offset < PRESSURE_FIXTURE_IO_TARGET_BYTES;
      offset += block.byteLength
    )
      await descriptor.write(block, 0, block.byteLength, offset);
    await descriptor.sync();
  };
  await primeIoPressureFixture({ markReady: ready, writeCycle });
}

if (mode === "disk")
  await writeFile(
    `${root}/disk-pressure.bin`,
    Buffer.alloc(PRESSURE_FIXTURE_DISK_TARGET_BYTES, 3),
    { flag: "wx", mode: 0o600 },
  );

if (mode === "inodes") {
  const directory = `${root}/inode-pressure`;
  await mkdir(directory, { mode: 0o700 });
  for (let index = 0; index < 3_200; index += 1)
    await writeFile(`${directory}/${String(index).padStart(4, "0")}`, "", {
      flag: "wx",
      mode: 0o600,
    });
}

if (mode !== "io" && mode !== "memory") await ready();

setInterval(() => retainedMemory.length + retainedWorkers.length, 1_000);
await new Promise(() => undefined);
