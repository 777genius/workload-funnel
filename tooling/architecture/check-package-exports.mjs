import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const packagesRoot = join(repositoryRoot, "packages");
const failures = [];
const packageDirectories = await readdir(packagesRoot, { withFileTypes: true });

for (const directory of packageDirectories.filter((entry) =>
  entry.isDirectory(),
)) {
  const packageRoot = join(packagesRoot, directory.name);
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (manifest.name === "@workload-funnel/kernel") {
    const declaration = manifest.exports?.["."];
    if (
      declaration?.types !== "./dist/index.d.ts" ||
      declaration?.import !== "./dist/index.js" ||
      Object.keys(declaration ?? {})
        .sort()
        .join() !== "import,types"
    ) {
      failures.push(
        "@workload-funnel/kernel must export only its built public index",
      );
    }
    await readFile(join(packageRoot, "src/index.ts"), "utf8").catch(() => {
      failures.push("@workload-funnel/kernel has no public src/index.ts");
    });
    continue;
  }
  const featuresRoot = join(packageRoot, "src/features");
  const features = (await readdir(featuresRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const exportsMap = manifest.exports ?? {};
  const exportKeys = Object.keys(exportsMap).sort();
  const expectedKeys = features.map((feature) => `./${feature}`);

  if (!manifest.name.startsWith("@workload-funnel/")) {
    failures.push(`${directory.name} does not use the approved package scope`);
  }
  if (features.length === 0) {
    failures.push(`${manifest.name} is an empty package`);
  }
  if (JSON.stringify(exportKeys) !== JSON.stringify(expectedKeys)) {
    failures.push(
      `${manifest.name} exports ${exportKeys.join(", ")} but owns ${expectedKeys.join(", ")}`,
    );
  }

  for (const feature of features) {
    const key = `./${feature}`;
    const expectedTypes = `./dist/features/${feature}/index.d.ts`;
    const expectedImport = `./dist/features/${feature}/index.js`;
    const declaration = exportsMap[key];
    if (
      declaration?.types !== expectedTypes ||
      declaration?.import !== expectedImport ||
      Object.keys(declaration ?? {})
        .sort()
        .join() !== "import,types"
    ) {
      failures.push(
        `${manifest.name} ${key} must export only its built public index`,
      );
    }
    await readFile(join(featuresRoot, feature, "index.ts"), "utf8").catch(
      () => {
        failures.push(`${manifest.name} ${key} has no public index.ts`);
      },
    );
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Package export check passed (${packageDirectories.length} packages)`,
  );
}
