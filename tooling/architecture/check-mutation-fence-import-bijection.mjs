import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  checkMutationFenceImportBijection,
  parseMutationFenceGrants,
} from "./mutation-fence-import-bijection.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
    )
  ).flat();
}

function nodeForSource(path) {
  const normalized = relative(repositoryRoot, path).split(sep).join("/");
  const packageMatch = normalized.match(
    /^packages\/([^/]+)\/src\/features\/([^/]+)\//u,
  );
  if (packageMatch !== null) return `${packageMatch[1]}/${packageMatch[2]}`;
  const appMatch = normalized.match(
    /^apps\/([^/]+)\/src\/features\/([^/]+)\//u,
  );
  if (appMatch !== null) return `apps/${appMatch[1]}/${appMatch[2]}`;
  if (normalized.startsWith("packages/kernel/src/")) return "kernel";
  return undefined;
}

const plan = await readFile(
  join(repositoryRoot, "docs/workload-funnel-architecture-plan.md"),
  "utf8",
);
const paths = (
  await Promise.all(
    ["apps", "packages"].map((root) => walk(join(repositoryRoot, root))),
  )
)
  .flat()
  .filter(
    (path) =>
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.includes(`${sep}tests${sep}`) &&
      !path.includes(`${sep}dist${sep}`),
  );
const entries = [];
for (const path of paths) {
  const nodeId = nodeForSource(path);
  if (nodeId === undefined) continue;
  entries.push({
    kernelOwner: nodeId === "kernel",
    nodeId,
    path: relative(repositoryRoot, path).split(sep).join("/"),
    source: await readFile(path, "utf8"),
  });
}

const failures = checkMutationFenceImportBijection(
  entries,
  parseMutationFenceGrants(plan),
);
if (failures.length > 0) {
  console.error(
    failures
      .map((failure) => `- ARCH-021 ${failure.code}: ${failure.message}`)
      .join("\n"),
  );
  process.exitCode = 1;
} else {
  console.log(
    `ARCH-021 mutation-fence import bijection passed (${String(entries.length)} source files)`,
  );
}
