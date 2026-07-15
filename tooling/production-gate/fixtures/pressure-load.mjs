import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { mkdir, open, writeFile } from "node:fs/promises";
import { setInterval, setTimeout } from "node:timers";

const [mode, root] = process.argv.slice(2);
if (
  !new Set(["cpu", "disk", "inodes", "io", "memory"]).has(mode) ||
  !/^\/var\/lib\/workload-funnel\/allocations\/wf-production-gate-[a-f0-9]{32}\/pressure$/u.test(
    root ?? "",
  )
)
  process.exit(64);

await mkdir(root, { mode: 0o700, recursive: true });
const retainedMemory = [];

if (mode === "cpu") {
  for (let index = 0; index < 4; index += 1)
    new Worker("for (;;) Math.imul(Date.now(), 17)", { eval: true });
}

if (mode === "memory") {
  for (let index = 0; index < 28; index += 1) {
    retainedMemory.push(Buffer.alloc(16 * 1024 * 1024, 1));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

if (mode === "io") {
  const descriptor = await open(`${root}/io-pressure.bin`, "w", 0o600);
  const block = Buffer.alloc(1024 * 1024, 2);
  for (;;) {
    for (let offset = 0; offset < 8 * 1024 * 1024; offset += block.byteLength)
      await descriptor.write(block, 0, block.byteLength, offset);
    await descriptor.sync();
  }
}

if (mode === "disk")
  await writeFile(
    `${root}/disk-pressure.bin`,
    Buffer.alloc(48 * 1024 * 1024, 3),
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

setInterval(() => retainedMemory.length, 1_000);
await new Promise(() => undefined);
