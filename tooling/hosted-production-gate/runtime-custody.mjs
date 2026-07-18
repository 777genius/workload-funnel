import { Buffer } from "node:buffer";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import { REVIEW_EXCLUDED_NAMES } from "./constants.mjs";
import { HostedGateRefusal, sha256 } from "./contract.mjs";
import { runCommand } from "./process-runner.mjs";

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function removeUnreviewedTrees(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (REVIEW_EXCLUDED_NAMES.has(entry.name)) {
      await rm(path, { force: true, recursive: true });
      continue;
    }
    if (entry.isDirectory()) await removeUnreviewedTrees(path);
  }
}

async function discoverWorkspacePackages(workspace) {
  const packages = new Map();
  for (const parent of ["apps", "packages"]) {
    let entries;
    try {
      entries = await readdir(`${workspace}/${parent}`, {
        withFileTypes: true,
      });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = `${workspace}/${parent}/${entry.name}`;
      try {
        const manifest = JSON.parse(
          await readFile(`${root}/package.json`, "utf8"),
        );
        if (typeof manifest.name === "string")
          packages.set(manifest.name, root);
      } catch (error) {
        if (error?.code !== "ENOENT")
          throw new HostedGateRefusal("runtime_dependency_manifest_invalid");
      }
    }
  }
  return packages;
}

async function resolveInstalledPackage(packageName, start, workspacePackages) {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = `${directory}/node_modules/${packageName}`;
    if (await exists(candidate)) return realpath(candidate);
    if (directory === "/") break;
  }
  const workspacePackage = workspacePackages.get(packageName);
  if (workspacePackage !== undefined) return workspacePackage;
  throw new HostedGateRefusal("runtime_dependency_missing");
}

function packageDependencies(manifest) {
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
  );
  return Object.freeze(
    [
      ...new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.optionalDependencies ?? {}),
        ...requiredPeers,
      ]),
    ].sort(),
  );
}

async function packageNode(packageName, sourceRoot, workspace) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(`${sourceRoot}/package.json`, "utf8"));
  } catch {
    throw new HostedGateRefusal("runtime_dependency_manifest_invalid");
  }
  refuse(
    manifest?.name !== packageName ||
      typeof manifest.version !== "string" ||
      !/^[A-Za-z0-9.+_-]{1,128}$/u.test(manifest.version),
    "runtime_dependency_manifest_invalid",
  );
  const workspaceRelative = relative(workspace, sourceRoot);
  return {
    dependencies: packageDependencies(manifest),
    external:
      workspaceRelative.startsWith("..") ||
      workspaceRelative.split("/").includes("node_modules"),
    name: packageName,
    sourceRoot,
    version: manifest.version,
  };
}

async function dependencyGraph(workspace, seeds) {
  const graph = new Map();
  const workspacePackages = await discoverWorkspacePackages(workspace);
  const visit = async (packageName, start) => {
    const sourceRoot = await resolveInstalledPackage(
      packageName,
      start,
      workspacePackages,
    );
    const key = `${packageName}\0${sourceRoot}`;
    if (graph.has(key)) return graph.get(key);
    refuse(graph.size >= 512, "runtime_dependency_inventory_too_large");
    const node = await packageNode(packageName, sourceRoot, workspace);
    graph.set(key, node);
    node.resolvedDependencies = [];
    for (const dependency of node.dependencies) {
      const child = await visit(dependency, sourceRoot);
      node.resolvedDependencies.push(child);
    }
    return node;
  };
  const roots = [];
  for (const seed of [...seeds].sort())
    roots.push(await visit(seed, workspace));
  return Object.freeze({ graph: Object.freeze([...graph.values()]), roots });
}

function safePackageDirectory(node, index) {
  const slug = node.name.replaceAll("@", "").replaceAll("/", "__");
  const suffix = sha256(
    Buffer.from(`${node.name}\0${node.version}\0${index}`, "utf8"),
  ).slice(0, 12);
  return `${slug}-${node.version}-${suffix}`;
}

async function copyPackage(source, destination) {
  await cp(source, destination, {
    errorOnExist: true,
    filter: (path) => basename(path) !== "node_modules",
    force: false,
    recursive: true,
    verbatimSymlinks: true,
  });
}

async function validateCopiedPackage(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isSymbolicLink())
      throw new HostedGateRefusal("runtime_dependency_symlink_refused");
    if (entry.isDirectory()) await validateCopiedPackage(path);
    else if (!entry.isFile())
      throw new HostedGateRefusal("runtime_dependency_entry_invalid");
  }
}

async function createRuntimeBundle(reviewRoot, custodyRoot, packageCount) {
  const path = `${reviewRoot}/reviewed-runtime-packages.tar`;
  const result = await runCommand(
    "/usr/bin/tar",
    [
      "--create",
      "--file",
      path,
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=posix",
      "--pax-option=delete=atime,delete=ctime",
      "--directory",
      dirname(custodyRoot),
      basename(custodyRoot),
    ],
    { maxOutputBytes: 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  refuse(result.code !== 0, "runtime_dependency_bundle_failed");
  return Object.freeze({
    packageCount,
    path,
    sha256: sha256(await readFile(path)),
  });
}

async function createPackageLink(link, target, reviewRoot) {
  refuse(
    !target.startsWith(`${reviewRoot}/`) || resolve(target) !== target,
    "runtime_dependency_target_untrusted",
  );
  await mkdir(dirname(link), { mode: 0o755, recursive: true });
  await symlink(target, link, "dir");
  refuse(
    (await realpath(link)) !== target,
    "runtime_dependency_link_untrusted",
  );
  return Object.freeze({ link, target });
}

async function collectRuntimeTree(
  root,
  { expectedGid = 0, expectedUid = 0, includeFiles, sealed = false },
) {
  const files = [];
  const links = [];
  const visit = async (directory) => {
    const directoryIdentity = await lstat(directory);
    refuse(
      !directoryIdentity.isDirectory() ||
        directoryIdentity.isSymbolicLink() ||
        (await realpath(directory)) !== directory ||
        (sealed &&
          (directoryIdentity.uid !== expectedUid ||
            directoryIdentity.gid !== expectedGid ||
            (directoryIdentity.mode & 0o222) !== 0)),
      "runtime_custody_directory_untrusted",
    );
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        links.push(Object.freeze({ link: path, target: await realpath(path) }));
      } else if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        if (includeFiles)
          files.push(
            Object.freeze({ path, sha256: sha256(await readFile(path)) }),
          );
      } else throw new HostedGateRefusal("runtime_custody_entry_invalid");
    }
  };
  await visit(root);
  return Object.freeze({
    files: Object.freeze(files),
    links: Object.freeze(links),
  });
}

function exactRuntimeIntegrity(value) {
  refuse(
    value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("\n") !==
        ["files", "links", "schemaVersion", "targetRoots"].sort().join("\n") ||
      value.schemaVersion !== "workload-funnel.hosted-runtime-custody.v2" ||
      !Array.isArray(value.targetRoots) ||
      value.targetRoots.length < 1 ||
      !Array.isArray(value.files) ||
      value.files.length < 1 ||
      !Array.isArray(value.links) ||
      value.links.length < 1,
    "runtime_custody_integrity_invalid",
  );
  return value;
}

function exactInventory(expected, observed, key, failure) {
  const expectedMap = new Map();
  for (const item of expected) {
    const identity = item?.[key];
    refuse(typeof identity !== "string" || expectedMap.has(identity), failure);
    expectedMap.set(identity, item);
  }
  refuse(
    observed.length !== expectedMap.size ||
      observed.some((item) => {
        const expectedItem = expectedMap.get(item[key]);
        return (
          expectedItem === undefined ||
          Object.keys(item).some(
            (field) => expectedItem[field] !== item[field],
          ) ||
          Object.keys(expectedItem).some(
            (field) => item[field] !== expectedItem[field],
          )
        );
      }),
    failure,
  );
}

export async function verifyRuntimeCustody(
  state,
  { expectedGid = 0, expectedUid = 0 } = {},
) {
  const { reviewRoot, runtimeIntegrity } = state;
  refuse(
    typeof reviewRoot !== "string" ||
      resolve(reviewRoot) !== reviewRoot ||
      runtimeIntegrity?.path !==
        `${reviewRoot}/reviewed-runtime-integrity.json` ||
      !/^[a-f0-9]{64}$/u.test(runtimeIntegrity?.sha256 ?? "") ||
      !Number.isSafeInteger(runtimeIntegrity?.fileCount) ||
      !Number.isSafeInteger(runtimeIntegrity?.linkCount),
    "runtime_custody_state_invalid",
  );
  const integrityIdentity = await lstat(runtimeIntegrity.path);
  const integrityBytes = await readFile(runtimeIntegrity.path);
  refuse(
    !integrityIdentity.isFile() ||
      integrityIdentity.isSymbolicLink() ||
      (await realpath(runtimeIntegrity.path)) !== runtimeIntegrity.path ||
      integrityIdentity.uid !== expectedUid ||
      integrityIdentity.gid !== expectedGid ||
      (integrityIdentity.mode & 0o222) !== 0 ||
      sha256(integrityBytes) !== runtimeIntegrity.sha256,
    "runtime_custody_manifest_drift",
  );
  let decoded;
  try {
    decoded = JSON.parse(integrityBytes.toString("utf8"));
  } catch {
    throw new HostedGateRefusal("runtime_custody_integrity_invalid");
  }
  const integrity = exactRuntimeIntegrity(decoded);
  refuse(
    runtimeIntegrity.fileCount !== integrity.files.length ||
      runtimeIntegrity.linkCount !== integrity.links.length,
    "runtime_custody_state_invalid",
  );
  const targetFiles = [];
  const targetRoots = new Set();
  for (const targetRoot of integrity.targetRoots) {
    refuse(
      typeof targetRoot !== "string" ||
        !targetRoot.startsWith(`${reviewRoot}/`) ||
        resolve(targetRoot) !== targetRoot ||
        targetRoots.has(targetRoot),
      "runtime_custody_target_invalid",
    );
    targetRoots.add(targetRoot);
    const target = await collectRuntimeTree(targetRoot, {
      includeFiles: true,
      sealed: true,
      expectedGid,
      expectedUid,
    });
    targetFiles.push(...target.files);
  }
  const review = await collectRuntimeTree(reviewRoot, {
    includeFiles: false,
    sealed: true,
    expectedGid,
    expectedUid,
  });
  exactInventory(
    integrity.files,
    targetFiles,
    "path",
    "runtime_custody_file_drift",
  );
  exactInventory(
    integrity.links,
    review.links,
    "link",
    "runtime_custody_link_drift",
  );
  for (const item of integrity.files) {
    refuse(
      Object.keys(item).sort().join("\n") !== "path\nsha256" ||
        typeof item.path !== "string" ||
        ![...targetRoots].some((root) => item.path.startsWith(`${root}/`)) ||
        resolve(item.path) !== item.path ||
        !/^[a-f0-9]{64}$/u.test(item.sha256),
      "runtime_custody_file_drift",
    );
    const identity = await lstat(item.path);
    refuse(
      identity.uid !== expectedUid ||
        identity.gid !== expectedGid ||
        (identity.mode & 0o222) !== 0,
      "runtime_custody_file_drift",
    );
  }
  for (const item of integrity.links) {
    refuse(
      Object.keys(item).sort().join("\n") !== "link\ntarget" ||
        typeof item.link !== "string" ||
        typeof item.target !== "string" ||
        !item.link.startsWith(`${reviewRoot}/`) ||
        !item.target.startsWith(`${reviewRoot}/`) ||
        resolve(item.link) !== item.link ||
        resolve(item.target) !== item.target,
      "runtime_custody_link_drift",
    );
    const identity = await lstat(item.link);
    refuse(
      !identity.isSymbolicLink() ||
        identity.uid !== expectedUid ||
        identity.gid !== expectedGid ||
        (await realpath(item.link)) !== item.target,
      "runtime_custody_link_drift",
    );
  }
  return Object.freeze({
    fileCount: integrity.files.length,
    linkCount: integrity.links.length,
    manifestSha256: runtimeIntegrity.sha256,
  });
}

export async function installRuntimeCustody({
  packageNames,
  reviewRoot,
  workspace,
}) {
  refuse(
    !Array.isArray(packageNames) ||
      packageNames.length === 0 ||
      packageNames.some(
        (name) =>
          typeof name !== "string" ||
          !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name),
      ),
    "runtime_dependency_seed_invalid",
  );
  const { graph, roots } = await dependencyGraph(workspace, packageNames);
  const custodyRoot = `${reviewRoot}/node_modules/.reviewed-runtime`;
  await mkdir(custodyRoot, { mode: 0o755, recursive: true });
  for (const [index, node] of graph.entries()) {
    if (node.external) {
      node.target = `${custodyRoot}/${safePackageDirectory(node, index)}`;
      await copyPackage(node.sourceRoot, node.target);
      await validateCopiedPackage(node.target);
    } else {
      node.target = `${reviewRoot}/${relative(workspace, node.sourceRoot)}`;
    }
  }
  const bundle = await createRuntimeBundle(
    reviewRoot,
    custodyRoot,
    graph.filter((node) => node.external).length,
  );
  const links = [];
  for (const node of graph)
    for (const dependency of node.resolvedDependencies)
      links.push(
        await createPackageLink(
          `${node.target}/node_modules/${dependency.name}`,
          dependency.target,
          reviewRoot,
        ),
      );
  for (const root of roots)
    links.push(
      await createPackageLink(
        `${reviewRoot}/node_modules/${root.name}`,
        root.target,
        reviewRoot,
      ),
    );
  const inventory = graph
    .map((node) =>
      Object.freeze({
        external: node.external,
        name: node.name,
        target: node.target,
        version: node.version,
      }),
    )
    .sort((left, right) =>
      `${left.name}\0${left.target}`.localeCompare(
        `${right.name}\0${right.target}`,
      ),
    );
  await writeFile(
    `${reviewRoot}/reviewed-runtime-packages.json`,
    `${JSON.stringify({ packages: inventory }, null, 2)}\n`,
    { flag: "wx", mode: 0o444 },
  );
  const targetRoots = [...new Set(graph.map((node) => node.target))].sort();
  const targetFiles = [];
  for (const targetRoot of targetRoots)
    targetFiles.push(
      ...(await collectRuntimeTree(targetRoot, { includeFiles: true })).files,
    );
  const integrityDocument = Object.freeze({
    files: Object.freeze(targetFiles),
    links: Object.freeze(
      links.sort((left, right) => left.link.localeCompare(right.link)),
    ),
    schemaVersion: "workload-funnel.hosted-runtime-custody.v2",
    targetRoots: Object.freeze(targetRoots),
  });
  const integrityPath = `${reviewRoot}/reviewed-runtime-integrity.json`;
  const integrityBytes = Buffer.from(
    `${JSON.stringify(integrityDocument, null, 2)}\n`,
    "utf8",
  );
  await writeFile(integrityPath, integrityBytes, { flag: "wx", mode: 0o444 });
  await chmod(integrityPath, 0o444);
  return Object.freeze({
    bundle,
    integrity: Object.freeze({
      fileCount: targetFiles.length,
      linkCount: links.length,
      path: integrityPath,
      sha256: sha256(integrityBytes),
    }),
    packages: Object.freeze(inventory),
  });
}
