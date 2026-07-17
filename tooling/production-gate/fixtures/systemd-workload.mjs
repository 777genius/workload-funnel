import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers";

const [mode, root] = process.argv.slice(2);
if (
  !new Set(["cpu", "io", "memory", "pids", "tree"]).has(mode) ||
  !root?.startsWith("/")
)
  process.exit(64);

await mkdir(root, { recursive: true });

if (mode === "memory") {
  const blocks = [];
  for (;;) {
    blocks.push(Buffer.alloc(64 * 1024 * 1024, 1));
  }
}

if (mode === "pids") {
  for (;;) {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        stdio: "ignore",
      },
    );
    child.once("error", async (error) => {
      if (error.code === "EAGAIN")
        await writeFile(`${root}/pids-limit-observed`, "EAGAIN\n");
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

if (mode === "io") {
  const block = Buffer.alloc(1024 * 1024, 1);
  for (let index = 0; index < 8; index += 1)
    await appendFile(`${root}/io-load.bin`, block);
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}

if (mode === "cpu") {
  for (;;) Math.imul(Date.now(), 17);
}

const descendants = [
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  }),
  spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  }),
];
const descendantManifest = `${root}/descendants.json`;
const pendingDescendantManifest = `${descendantManifest}.${String(process.pid)}.tmp`;
await writeFile(
  pendingDescendantManifest,
  `${JSON.stringify(descendants.map((child) => child.pid))}\n`,
  { mode: 0o600 },
);
await rename(pendingDescendantManifest, descendantManifest);
await new Promise(() => undefined);
