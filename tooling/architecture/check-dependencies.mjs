import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const architecturePlanPath = join(
  repositoryRoot,
  "docs/workload-funnel-architecture-plan.md",
);
const sourceRoots = ["apps", "packages"];
const failures = [];
const applicationWorkspaceNames = new Set(
  (await readdir(join(repositoryRoot, "apps"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return paths.flat();
}

function parseDependencyRules(plan) {
  const heading = "#### 8.3.1 Enforceable feature dependency DAG";
  const start = plan.indexOf(heading);
  if (start < 0) {
    throw new Error(`Architecture plan is missing ${heading}`);
  }

  const section = plan.slice(start, plan.indexOf("#### 8.3.2", start));
  const rules = new Map();
  const rowPattern = /^\| `([^`]+)` \| (.+) \|$/gm;

  for (const match of section.matchAll(rowPattern)) {
    const [, nodeId, targetCell] = match;
    if (nodeId === undefined || targetCell === undefined) continue;
    if (rules.has(nodeId)) failures.push(`Duplicate dependency row: ${nodeId}`);

    const targets =
      targetCell === "∅"
        ? []
        : [...targetCell.matchAll(/`([^`]+)`/g)].map((target) => target[1]);
    const rendered =
      targets.length === 0
        ? "∅"
        : targets.map((target) => `\`${target}\``).join(", ");

    if (
      rendered !== targetCell ||
      [...targets].sort().join() !== targets.join()
    ) {
      failures.push(`Malformed or non-lexical dependency cell for ${nodeId}`);
    }
    rules.set(nodeId, new Set(targets));
  }

  if (rules.size === 0) throw new Error("No dependency rules parsed from plan");
  for (const [nodeId, targets] of rules) {
    for (const target of targets) {
      if (!rules.has(target)) {
        failures.push(`${nodeId} refers to unknown dependency node ${target}`);
      }
    }
  }

  return rules;
}

function checkCycles(rules) {
  const complete = new Set();
  const active = new Set();

  function visit(nodeId, path) {
    if (active.has(nodeId)) {
      failures.push(`Dependency cycle: ${[...path, nodeId].join(" -> ")}`);
      return;
    }
    if (complete.has(nodeId)) return;

    active.add(nodeId);
    for (const target of rules.get(nodeId) ?? [])
      visit(target, [...path, nodeId]);
    active.delete(nodeId);
    complete.add(nodeId);
  }

  for (const nodeId of rules.keys()) visit(nodeId, []);
}

function checkCompositionInventory(plan, rules) {
  const expected = plan.match(
    /contains exactly (\d+) `B`, (\d+) `C`, (\d+) `E`, and (\d+) `K`/u,
  );
  if (expected === null) {
    failures.push("Architecture plan has no composition inventory counts");
    return;
  }
  const relations = ["B", "C", "E", "K"];
  const expectedCounts = expected.slice(1).map(Number);
  for (const [index, relation] of relations.entries()) {
    const count = [...plan.matchAll(new RegExp(`^${relation}\\|`, "gmu"))]
      .length;
    if (count !== expectedCounts[index]) {
      failures.push(
        `${relation} inventory count ${String(count)} does not match ${String(expectedCounts[index])}`,
      );
    }
  }
  const kernelRows = [...plan.matchAll(/^K\|([^|]+)\|[^\n]+$/gmu)].map(
    (match) => match[1],
  );
  if (new Set(kernelRows).size !== kernelRows.length) {
    failures.push("Composition inventory has duplicate K rows");
  }
  const missingKernelRows = [...rules.keys()].filter(
    (nodeId) => !kernelRows.includes(nodeId),
  );
  const extraKernelRows = kernelRows.filter((nodeId) => !rules.has(nodeId));
  if (missingKernelRows.length > 0 || extraKernelRows.length > 0) {
    failures.push(
      `K inventory differs from DAG nodes (missing=${missingKernelRows.join(",")}; extra=${extraKernelRows.join(",")})`,
    );
  }
}

function nodeForSource(path) {
  const normalized = relative(repositoryRoot, path).split(sep).join("/");
  if (normalized.startsWith("packages/kernel/src/")) return "kernel";
  const packageMatch = normalized.match(
    /^packages\/([^/]+)\/src\/features\/([^/]+)\//,
  );
  if (packageMatch !== null) return `${packageMatch[1]}/${packageMatch[2]}`;

  const appFeatureMatch = normalized.match(
    /^apps\/([^/]+)\/src\/features\/([^/]+)\//,
  );
  if (appFeatureMatch !== null) {
    return `apps/${appFeatureMatch[1]}/${appFeatureMatch[2]}`;
  }

  const generatedMatch = normalized.match(
    /^apps\/control-service\/src\/generated\/composition\.(control-(?:postgres|sqlite))\.ts$/,
  );
  if (generatedMatch !== null) {
    return `apps/control-service/composition-${generatedMatch[1]?.slice("control-".length)}`;
  }

  return undefined;
}

function layerForSource(path) {
  const normalized = path.split(sep).join("/");
  for (const layer of ["domain", "application", "adapters", "api", "tests"]) {
    if (normalized.includes(`/${layer}/`)) return layer;
  }
  return "public";
}

function importedSpecifiers(source) {
  const imports = [];
  const pattern =
    /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) imports.push(specifier);
  }
  return imports;
}

function sourcePathForRelativeImport(sourcePath, specifier) {
  const candidate = resolve(dirname(sourcePath), specifier);
  if (extname(candidate) === ".js") return `${candidate.slice(0, -3)}.ts`;
  return candidate;
}

function targetNodeForWorkspaceImport(specifier) {
  if (specifier === "@workload-funnel/kernel") return "kernel";
  const match = specifier.match(/^@workload-funnel\/([^/]+)\/([^/]+)$/);
  if (match === null) return undefined;
  return applicationWorkspaceNames.has(match[1])
    ? `apps/${match[1]}/${match[2]}`
    : `${match[1]}/${match[2]}`;
}

function workspaceForSource(path) {
  const normalized = relative(repositoryRoot, path).split(sep).join("/");
  const match = normalized.match(/^(apps|packages)\/([^/]+)\//);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

function checkLayerDirection(sourcePath, targetPath) {
  const sourceLayer = layerForSource(sourcePath);
  const targetLayer = layerForSource(targetPath);
  const forbiddenByLayer = {
    adapters: new Set(["api", "public"]),
    api: new Set(["adapters", "public"]),
    application: new Set(["adapters", "api", "public"]),
    domain: new Set(["adapters", "api", "application", "public"]),
    public: new Set(["adapters"]),
  };
  if (forbiddenByLayer[sourceLayer]?.has(targetLayer) === true) {
    failures.push(
      `${relative(repositoryRoot, sourcePath)} (${sourceLayer}) imports ${targetLayer} layer`,
    );
  }
}

const plan = await readFile(architecturePlanPath, "utf8");
const rules = parseDependencyRules(plan);
checkCycles(rules);
checkCompositionInventory(plan, rules);

const sourceFiles = (
  await Promise.all(
    sourceRoots.map((root) => walk(join(repositoryRoot, root)).catch(() => [])),
  )
)
  .flat()
  .filter((path) => path.includes(`${sep}src${sep}`) && path.endsWith(".ts"));
const productionFiles = sourceFiles.filter(
  (path) => !path.endsWith(".test.ts") && !path.includes(`${sep}tests${sep}`),
);
const workspaceManifests = new Map();
for (const workspace of new Set(productionFiles.map(workspaceForSource))) {
  if (workspace === undefined) continue;
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, workspace, "package.json"), "utf8"),
  );
  workspaceManifests.set(workspace, manifest);
}

const forbiddenIntegrationImports = [
  "@anthropic-ai/",
  "@kubernetes/",
  "artifact-store-object",
  "dockerode",
  "hyperqueue",
  "node-systemd",
  "subscription-runtime",
];

for (const path of productionFiles) {
  const sourceNode = nodeForSource(path);
  const displayPath = relative(repositoryRoot, path);
  if (sourceNode === undefined) {
    failures.push(
      `${displayPath} is outside a feature or approved generated root`,
    );
    continue;
  }
  if (sourceNode !== "kernel" && !rules.has(sourceNode)) {
    failures.push(
      `${displayPath} maps to unknown architecture node ${sourceNode}`,
    );
  }

  const source = await readFile(path, "utf8");
  if (source.split(/\r?\n/u).length > 800) {
    failures.push(`${displayPath} exceeds the 800-line source hard cap`);
  }
  if (/\brequire\s*\(/u.test(source)) {
    failures.push(
      `${displayPath} uses CommonJS require instead of static ESM imports`,
    );
  }
  for (const dynamicImport of source.matchAll(/\bimport\s*\(\s*([^)]*)\)/gu)) {
    if (!/^["'][^"']+["']\s*$/u.test(dynamicImport[1] ?? "")) {
      failures.push(`${displayPath} contains a non-literal dynamic import`);
    }
  }
  for (const specifier of importedSpecifiers(source)) {
    const approvedPostgresDriver =
      sourceNode === "store-postgres/workload-persistence" &&
      specifier === "pg";
    const declaredHyperQueueAdapterImport =
      specifier.startsWith("@workload-funnel/scheduler-hyperqueue/") ||
      specifier.startsWith("@workload-funnel/scheduler-mutation-gateway/");
    if (
      !declaredHyperQueueAdapterImport &&
      !approvedPostgresDriver &&
      (specifier === "pg" ||
        specifier.startsWith("pg/") ||
        specifier === "postgres" ||
        specifier.startsWith("postgres/") ||
        forbiddenIntegrationImports.some((forbidden) =>
          specifier.includes(forbidden),
        ))
    ) {
      failures.push(
        `${displayPath} imports forbidden Phase 0 integration ${specifier}`,
      );
    }

    if (specifier.startsWith(".")) {
      const targetPath = sourcePathForRelativeImport(path, specifier);
      const targetNode = nodeForSource(targetPath);
      if (targetNode !== sourceNode) {
        failures.push(
          `${displayPath} bypasses a public feature export with ${specifier}`,
        );
      } else {
        checkLayerDirection(path, targetPath);
      }
      continue;
    }

    if (specifier.startsWith("@workload-funnel/")) {
      const targetNode = targetNodeForWorkspaceImport(specifier);
      const sourceWorkspace = workspaceForSource(path);
      if (targetNode === undefined) {
        failures.push(
          `${displayPath} imports a package root or internal path: ${specifier}`,
        );
      } else if (targetNode === sourceNode) {
        failures.push(
          `${displayPath} imports its own feature through its package export`,
        );
      } else if (
        targetNode !== "kernel" &&
        rules.get(sourceNode)?.has(targetNode) !== true
      ) {
        failures.push(
          `${sourceNode} may not import ${targetNode} (${displayPath})`,
        );
      }

      const targetPackage = specifier.split("/").slice(0, 2).join("/");
      if (
        sourceWorkspace !== undefined &&
        workspaceManifests.get(sourceWorkspace)?.name !== targetPackage &&
        workspaceManifests.get(sourceWorkspace)?.dependencies?.[
          targetPackage
        ] === undefined
      ) {
        failures.push(
          `${displayPath} imports undeclared dependency ${targetPackage}`,
        );
      }
    } else if (layerForSource(path) === "domain") {
      failures.push(
        `${displayPath} domain imports external module ${specifier}`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Architecture dependency check passed (${rules.size} DAG nodes, ${productionFiles.length} source files)`,
  );
}
