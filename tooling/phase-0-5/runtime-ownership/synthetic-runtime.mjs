import { writeFile } from "node:fs/promises";

const outputPath = process.argv[2];
if (outputPath === undefined)
  throw new Error("Synthetic output path is required");

await writeFile(
  outputPath,
  JSON.stringify({
    daemonized: false,
    pid: process.pid,
    ppid: process.ppid,
    tmux: process.env.TMUX !== undefined,
  }),
);
