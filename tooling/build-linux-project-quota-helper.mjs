import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const source = resolve(
  repositoryRoot,
  "packages/executor-systemd/src/features/transient-unit-start/native/linux-project-quota.c",
);
const output = resolve(
  repositoryRoot,
  "packages/executor-systemd/dist/native/linux-project-quota",
);
mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
const result = spawnSync(
  "/usr/bin/cc",
  ["-std=c17", "-O2", "-Wall", "-Wextra", "-Werror", source, "-o", output],
  {
    encoding: "utf8",
    env: {
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
    },
  },
);
if (result.status !== 0 || result.signal !== null) {
  process.stderr.write(result.stderr || "native project-quota build failed\n");
  process.exitCode = 1;
}
