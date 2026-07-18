import { Buffer } from "node:buffer";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";

import {
  AWS_CLI,
  POSTGRES_CLIENT,
  POSTGRES_SIGNING_KEY,
} from "./constants.mjs";
import { HostedGateRefusal, sha256 } from "./contract.mjs";
import { inspectExecutable } from "./review-manifest.mjs";
import { runCommand } from "./process-runner.mjs";

function refuse(condition, code) {
  if (condition) throw new HostedGateRefusal(code);
}

async function required(executable, arguments_, failure, options) {
  const result = await runCommand(executable, arguments_, options);
  if (result.code !== 0) throw new HostedGateRefusal(failure);
  return result;
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

export async function downloadHttps(url, maximumBytes = 256 * 1024 * 1024) {
  const original = new globalThis.URL(url);
  refuse(original.protocol !== "https:", "download_url_untrusted");
  const response = await globalThis.fetch(original, {
    redirect: "follow",
    signal: globalThis.AbortSignal.timeout(120_000),
  });
  refuse(!response.ok || response.body === null, "download_failed");
  const final = new globalThis.URL(response.url);
  const allowedHosts = new Set([
    "awscli.amazonaws.com",
    "github.com",
    "keyserver.ubuntu.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
    "www.postgresql.org",
  ]);
  refuse(
    final.protocol !== "https:" || !allowedHosts.has(final.hostname),
    "download_redirect_untrusted",
  );
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    refuse(!/^[0-9]+$/u.test(contentLength), "download_size_invalid");
    const length = Number(contentLength);
    refuse(
      !Number.isSafeInteger(length) || length < 1 || length > maximumBytes,
      "download_size_invalid",
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  refuse(
    bytes.length < 1 || bytes.length > maximumBytes,
    "download_size_invalid",
  );
  return bytes;
}

export function verifyPostgresKeyListing(listing) {
  const fingerprints = listing
    .split("\n")
    .filter((line) => line.startsWith("fpr:"))
    .map((line) => line.split(":")[9]);
  refuse(
    fingerprints.length !== 1 ||
      fingerprints[0] !== POSTGRES_SIGNING_KEY.fingerprint,
    "postgres_signing_key_untrusted",
  );
  return POSTGRES_SIGNING_KEY.fingerprint;
}

export function verifyAwsKeyListing(listing) {
  const primaryFingerprints = [];
  const lines = listing.split("\n");
  for (let index = 0; index < lines.length; index += 1)
    if (lines[index].startsWith("pub:")) {
      const fingerprint = lines
        .slice(index + 1)
        .find((line) => line.startsWith("fpr:"))
        ?.split(":")[9];
      if (fingerprint !== undefined) primaryFingerprints.push(fingerprint);
    }
  refuse(
    primaryFingerprints.length !== 1 ||
      primaryFingerprints[0] !== AWS_CLI.signingKeyFingerprint,
    "aws_signing_key_untrusted",
  );
  return AWS_CLI.signingKeyFingerprint;
}

export function verifyAwsSignatureStatus(status) {
  const valid = status
    .split("\n")
    .filter((line) => line.startsWith("[GNUPG:] VALIDSIG "))
    .map((line) => line.trim().split(/\s+/u));
  refuse(
    valid.length !== 1 ||
      !new Set([valid[0][2], valid[0].at(-1)]).has(
        AWS_CLI.signingKeyFingerprint,
      ),
    "aws_archive_signature_untrusted",
  );
  return AWS_CLI.signingKeyFingerprint;
}

export function verifyAwsArchiveSha256(observedSha256) {
  refuse(
    observedSha256 !== AWS_CLI.archiveSha256,
    "aws_archive_sha256_mismatch",
  );
  return observedSha256;
}

export function verifyAwsCliVersion(output) {
  const match = output.match(
    /^aws-cli\/([0-9]+\.[0-9]+\.[0-9]+)(?: [^\r\n]{1,512})?\r?\n?$/u,
  );
  refuse(match?.[1] !== AWS_CLI.version, "aws_cli_version_mismatch");
  return match[1];
}

export function verifyPsqlVersion(output, packageVersion) {
  refuse(
    packageVersion !== POSTGRES_CLIENT.packageVersion ||
      !new RegExp(
        `^psql \\(PostgreSQL\\) ${POSTGRES_CLIENT.psqlVersion.replace(".", "\\.")}(?: \\([^\\r\\n]{1,128}\\))?\\n$`,
        "u",
      ).test(output),
    "postgres_client_18_4_version_mismatch",
  );
  return POSTGRES_CLIENT.psqlVersion;
}

export function verifyPostgresNotPreinstalled(
  executableExists,
  packageQueryExitCode,
) {
  refuse(
    executableExists === true || packageQueryExitCode === 0,
    "postgres_client_preinstalled_refused",
  );
  refuse(
    executableExists !== false || packageQueryExitCode !== 1,
    "postgres_client_inventory_failed",
  );
  return true;
}

export function postgresAptConfiguration(hostRoot) {
  refuse(
    typeof hostRoot !== "string" ||
      !/^\/opt\/workload-funnel-hosted-production-gate-[a-f0-9]{32}$/u.test(
        hostRoot,
      ),
    "postgres_apt_root_invalid",
  );
  const archivesPath = `${hostRoot}/postgres-apt/archives`;
  const keyringPath = `${hostRoot}/postgres-apt/ACCC4CF8.gpg`;
  const listsPath = `${hostRoot}/postgres-apt/lists`;
  const sourceListPath = `${hostRoot}/postgres-apt/postgresql.list`;
  const aptSource = `deb [arch=amd64 signed-by=${keyringPath}] ${POSTGRES_CLIENT.aptRepository} ${POSTGRES_CLIENT.aptSuite} ${POSTGRES_CLIENT.aptComponent}`;
  return Object.freeze({
    aptSource,
    archivesPath,
    keyringPath,
    listsPath,
    sourceListPath,
  });
}

export function isolatedPostgresAptArguments(hostRoot, arguments_) {
  const configuration = postgresAptConfiguration(hostRoot);
  refuse(
    !Array.isArray(arguments_) ||
      arguments_.length === 0 ||
      arguments_.some(
        (item) => typeof item !== "string" || item.includes("\0"),
      ),
    "postgres_apt_arguments_invalid",
  );
  return Object.freeze([
    "-o",
    `Dir::Etc::sourcelist=${configuration.sourceListPath}`,
    "-o",
    "Dir::Etc::sourceparts=-",
    "-o",
    `Dir::State::lists=${configuration.listsPath}`,
    "-o",
    `Dir::Cache::archives=${configuration.archivesPath}`,
    "-o",
    "Dir::Cache::pkgcache=",
    "-o",
    "Dir::Cache::srcpkgcache=",
    "-o",
    "Acquire::AllowInsecureRepositories=false",
    "-o",
    "Acquire::AllowDowngradeToInsecureRepositories=false",
    "-o",
    "APT::Get::AllowUnauthenticated=false",
    ...arguments_,
  ]);
}

function validatePackageInventory(inventory) {
  refuse(
    inventory === null ||
      typeof inventory !== "object" ||
      Array.isArray(inventory) ||
      Object.entries(inventory).some(
        ([name, version]) =>
          !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/u.test(name) ||
          typeof version !== "string" ||
          !/^[^\s\0]{1,256}$/u.test(version),
      ),
    "package_inventory_invalid",
  );
  return inventory;
}

export async function installedPackageInventory() {
  const result = await required(
    "/usr/bin/dpkg-query",
    ["--show", "--showformat=${binary:Package}\\t${Version}\\n"],
    "package_inventory_failed",
    { maxOutputBytes: 16 * 1024 * 1024 },
  );
  const inventory = {};
  for (const line of result.stdout.trim().split("\n")) {
    const [name, version, ...extra] = line.split("\t");
    refuse(
      extra.length !== 0 || inventory[name] !== undefined,
      "package_inventory_invalid",
    );
    inventory[name] = version;
  }
  return Object.freeze(validatePackageInventory(inventory));
}

export function packageInventoryDiff(baseline, observed) {
  validatePackageInventory(baseline);
  validatePackageInventory(observed);
  const installed = [];
  const changed = [];
  const removed = [];
  for (const [name, version] of Object.entries(observed)) {
    const previous = baseline[name];
    if (previous === undefined) installed.push({ name, version });
    else if (previous !== version)
      changed.push({ from: previous, name, to: version });
  }
  for (const [name, version] of Object.entries(baseline))
    if (observed[name] === undefined) removed.push({ name, version });
  const order = (left, right) => left.name.localeCompare(right.name);
  return Object.freeze({
    changed: Object.freeze(changed.sort(order)),
    installed: Object.freeze(installed.sort(order)),
    removed: Object.freeze(removed.sort(order)),
  });
}

export function parseAptSimulation(output) {
  const planned = [];
  for (const line of output.split("\n")) {
    refuse(line.startsWith("Remv "), "package_plan_removal_refused");
    if (!line.startsWith("Inst ")) continue;
    const match = line.match(
      /^Inst ([a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?)(?: \[[^\]]+\])? \(([^\s)]+)(?: [^)]*)?\)$/u,
    );
    refuse(match === null, "package_plan_output_invalid");
    planned.push({ name: match[1], targetVersion: match[2] });
  }
  refuse(planned.length > 128, "package_plan_too_large");
  return Object.freeze(planned);
}

export function exactPackagePlan(baseline, ...simulations) {
  validatePackageInventory(baseline);
  const targets = new Map();
  for (const item of simulations.flat()) {
    refuse(
      item === null ||
        typeof item !== "object" ||
        !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9][a-z0-9-]*)?$/u.test(
          item.name ?? "",
        ) ||
        !/^[^\s\0]{1,256}$/u.test(item.targetVersion ?? ""),
      "package_plan_invalid",
    );
    const baselineMatches = Object.keys(baseline).filter(
      (name) => name === item.name || name.startsWith(`${item.name}:`),
    );
    refuse(baselineMatches.length > 1, "package_plan_architecture_ambiguous");
    const name = baselineMatches[0] ?? item.name;
    refuse(
      targets.has(name) && targets.get(name) !== item.targetVersion,
      "package_plan_invalid",
    );
    targets.set(name, item.targetVersion);
  }
  refuse(targets.size < 1 || targets.size > 128, "package_plan_invalid");
  return Object.freeze(
    [...targets]
      .map(([name, targetVersion]) =>
        Object.freeze({
          baselineVersion: baseline[name] ?? null,
          name,
          targetVersion,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

export function classifyOwnedPackagePlan(plan, observed) {
  validatePackageInventory(observed);
  refuse(!Array.isArray(plan) || plan.length > 128, "package_plan_invalid");
  const remove = [];
  const restore = [];
  for (const item of plan) {
    const matches = Object.keys(observed).filter(
      (name) => name === item.name || name.startsWith(`${item.name}:`),
    );
    refuse(matches.length > 1, "owned_package_identity_ambiguous");
    const observedName = matches[0] ?? item.name;
    const value = observed[observedName];
    if (item.baselineVersion === null) {
      if (value === item.targetVersion) remove.push(observedName);
      else if (value !== undefined)
        throw new HostedGateRefusal("owned_package_identity_changed");
    } else if (value === item.targetVersion)
      restore.push({ name: item.name, version: item.baselineVersion });
    else if (value !== item.baselineVersion)
      throw new HostedGateRefusal("owned_package_identity_changed");
  }
  return Object.freeze({
    remove: Object.freeze(remove),
    restore: Object.freeze(restore),
  });
}

export function exactAppliedPackageChanges(baseline, plan, observed) {
  validatePackageInventory(baseline);
  validatePackageInventory(observed);
  refuse(!Array.isArray(plan) || plan.length < 1, "package_plan_invalid");
  const changes = packageInventoryDiff(baseline, observed);
  const expected = {
    changed: plan
      .filter((item) => item.baselineVersion !== null)
      .map((item) => ({
        from: item.baselineVersion,
        name: item.name,
        to: item.targetVersion,
      })),
    installed: plan
      .filter((item) => item.baselineVersion === null)
      .map((item) => ({ name: item.name, version: item.targetVersion })),
    removed: [],
  };
  refuse(
    JSON.stringify(changes) !== JSON.stringify(expected),
    "bootstrap_package_change_untrusted",
  );
  return changes;
}

function validateZipInventory(listing) {
  const paths = listing.trim().split("\n").filter(Boolean);
  refuse(
    paths.length === 0 ||
      !paths.includes("aws/install") ||
      paths.some(
        (path) =>
          !path.startsWith("aws/") ||
          path.includes("\\") ||
          path.startsWith("/") ||
          path
            .split("/")
            .slice(0, -1)
            .some(
              (segment) =>
                segment === "" || segment === "." || segment === "..",
            ),
      ),
    "aws_archive_paths_unsafe",
  );
}

async function validateExtractedTree(root, extractionRoot = root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      refuse(
        !target.startsWith(`${extractionRoot}/`),
        "aws_archive_symlink_refused",
      );
    } else if (entry.isDirectory())
      await validateExtractedTree(path, extractionRoot);
    else if (!entry.isFile())
      throw new HostedGateRefusal("aws_archive_entry_invalid");
  }
}

export async function installExactAwsCli(hostRoot) {
  const archivePath = `${hostRoot}/${AWS_CLI.archiveName}`;
  const signaturePath = `${archivePath}.sig`;
  const keyPath = `${hostRoot}/aws-cli-signing-key.asc`;
  const [archive, signature, signingKey] = await Promise.all([
    downloadHttps(AWS_CLI.archiveUrl),
    downloadHttps(AWS_CLI.signatureUrl, 1024 * 1024),
    downloadHttps(AWS_CLI.signingKeyUrl, 1024 * 1024),
  ]);
  const archiveSha256 = verifyAwsArchiveSha256(sha256(archive));
  await Promise.all([
    writeFile(archivePath, archive, { flag: "wx", mode: 0o400 }),
    writeFile(signaturePath, signature, { flag: "wx", mode: 0o400 }),
    writeFile(keyPath, signingKey, { flag: "wx", mode: 0o400 }),
  ]);
  const gpgHome = `${hostRoot}/aws-gpg`;
  await mkdir(gpgHome, { mode: 0o700 });
  const listing = await required(
    "/usr/bin/gpg",
    ["--batch", "--homedir", gpgHome, "--show-keys", "--with-colons", keyPath],
    "aws_signing_key_inspection_failed",
  );
  verifyAwsKeyListing(listing.stdout);
  await required(
    "/usr/bin/gpg",
    ["--batch", "--homedir", gpgHome, "--import", keyPath],
    "aws_signing_key_import_failed",
  );
  const verification = await required(
    "/usr/bin/gpg",
    [
      "--batch",
      "--homedir",
      gpgHome,
      "--status-fd",
      "1",
      "--verify",
      signaturePath,
      archivePath,
    ],
    "aws_archive_signature_untrusted",
  );
  verifyAwsSignatureStatus(verification.stdout);
  const inventory = await required(
    "/usr/bin/unzip",
    ["-Z1", archivePath],
    "aws_archive_inventory_failed",
    { maxOutputBytes: 16 * 1024 * 1024 },
  );
  validateZipInventory(inventory.stdout);
  const extractRoot = `${hostRoot}/aws-extract`;
  await mkdir(extractRoot, { mode: 0o700 });
  await required(
    "/usr/bin/unzip",
    ["-q", archivePath, "-d", extractRoot],
    "aws_archive_extract_failed",
    { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 5 * 60_000 },
  );
  await validateExtractedTree(extractRoot);
  await required(
    `${extractRoot}/aws/install`,
    [
      "--install-dir",
      `${hostRoot}/aws-cli`,
      "--bin-dir",
      `${hostRoot}/aws-bin`,
    ],
    "aws_cli_install_failed",
    { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 5 * 60_000 },
  );
  const executable = await realpath(`${hostRoot}/aws-bin/aws`);
  refuse(
    executable !== `${hostRoot}/aws-cli/v2/${AWS_CLI.version}/dist/aws`,
    "aws_cli_canonical_binary_mismatch",
  );
  const identity = await inspectExecutable(executable);
  refuse(
    identity.uid !== 0 ||
      identity.gid !== 0 ||
      (identity.mode & 0o022) !== 0 ||
      (identity.mode & 0o111) === 0,
    "aws_cli_identity_untrusted",
  );
  const versionResult = await required(
    executable,
    ["--version"],
    "aws_cli_version_probe_failed",
  );
  const version = verifyAwsCliVersion(
    `${versionResult.stdout}${versionResult.stderr}`,
  );
  await rm(extractRoot, { force: true, recursive: true });
  return Object.freeze({
    archivePath,
    evidence: Object.freeze({
      archiveUrl: AWS_CLI.archiveUrl,
      archiveSha256,
      binaryPath: executable,
      binarySha256: identity.sha256,
      runnerPreinstallAccepted: false,
      signatureUrl: AWS_CLI.signatureUrl,
      signerFingerprint: AWS_CLI.signingKeyFingerprint,
      version,
    }),
    executable,
    keyPath,
    signaturePath,
  });
}

async function pgdgMetadata(apt, keyPath) {
  const files = [];
  const visit = async (root) => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = `${root}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new HostedGateRefusal("postgres_metadata_symlink_refused");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile())
        files.push({ path, sha256: sha256(await readFile(path)) });
      else throw new HostedGateRefusal("postgres_metadata_entry_invalid");
    }
  };
  await visit(apt.listsPath);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    aptSource: apt.aptSource,
    keyFingerprint: POSTGRES_SIGNING_KEY.fingerprint,
    keyringPath: apt.keyringPath,
    keyringSha256: sha256(await readFile(apt.keyringPath)),
    keySourcePath: keyPath,
    keySourceSha256: sha256(await readFile(keyPath)),
    lists: Object.freeze(files),
    sourceListPath: apt.sourceListPath,
    sourceListSha256: sha256(await readFile(apt.sourceListPath)),
  });
}

export async function prepareExactPostgresClient(hostRoot) {
  const executable = "/usr/lib/postgresql/18/bin/psql";
  const executableExists = await exists(executable);
  const preinstalled = await runCommand("/usr/bin/dpkg-query", [
    "--show",
    "--showformat=${Version}\\n",
    POSTGRES_CLIENT.packageName,
  ]);
  verifyPostgresNotPreinstalled(executableExists, preinstalled.code);
  const apt = postgresAptConfiguration(hostRoot);
  const keyPath = `${hostRoot}/ACCC4CF8.asc`;
  await writeFile(
    keyPath,
    await downloadHttps(POSTGRES_SIGNING_KEY.url, 256 * 1024),
    {
      flag: "wx",
      mode: 0o400,
    },
  );
  const gpgHome = `${hostRoot}/postgres-gpg`;
  await mkdir(gpgHome, { mode: 0o700 });
  await mkdir(`${hostRoot}/postgres-apt`, { mode: 0o700 });
  await mkdir(`${apt.listsPath}/partial`, { mode: 0o700, recursive: true });
  await mkdir(`${apt.archivesPath}/partial`, { mode: 0o700, recursive: true });
  const listing = await required(
    "/usr/bin/gpg",
    ["--batch", "--homedir", gpgHome, "--show-keys", "--with-colons", keyPath],
    "postgres_signing_key_inspection_failed",
  );
  verifyPostgresKeyListing(listing.stdout);
  await required(
    "/usr/bin/gpg",
    [
      "--batch",
      "--homedir",
      gpgHome,
      "--yes",
      "--dearmor",
      "--output",
      apt.keyringPath,
      keyPath,
    ],
    "postgres_signing_key_install_failed",
  );
  await chmod(apt.keyringPath, 0o444);
  await writeFile(apt.sourceListPath, `${apt.aptSource}\n`, {
    flag: "wx",
    mode: 0o444,
  });
  await required(
    "/usr/bin/apt-get",
    isolatedPostgresAptArguments(hostRoot, ["update"]),
    "signed_package_index_update_failed",
    { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  const simulation = await required(
    "/usr/bin/apt-get",
    isolatedPostgresAptArguments(hostRoot, [
      "--simulate",
      "install",
      "--no-install-recommends",
      "--",
      `${POSTGRES_CLIENT.packageName}=${POSTGRES_CLIENT.packageVersion}`,
    ]),
    "signed_package_plan_failed",
    { maxOutputBytes: 16 * 1024 * 1024 },
  );
  return Object.freeze({
    apt,
    executable,
    hostRoot,
    keyPath,
    metadata: await pgdgMetadata(apt, keyPath),
    packageSimulation: parseAptSimulation(simulation.stdout),
  });
}

export async function installPreparedPostgresClient(prepared) {
  const { apt, executable, hostRoot, keyPath } = prepared;
  await required(
    "/usr/bin/apt-get",
    isolatedPostgresAptArguments(hostRoot, [
      "install",
      "--yes",
      "--no-install-recommends",
      "--no-remove",
      "--",
      `${POSTGRES_CLIENT.packageName}=${POSTGRES_CLIENT.packageVersion}`,
    ]),
    "signed_package_install_failed",
    { maxOutputBytes: 16 * 1024 * 1024, timeoutMs: 10 * 60_000 },
  );
  const packageResult = await required(
    "/usr/bin/dpkg-query",
    ["--show", "--showformat=${Version}\\n", POSTGRES_CLIENT.packageName],
    "postgres_client_package_identity_missing",
  );
  const packageVersion = packageResult.stdout.trim();
  const psqlResult = await required(
    executable,
    ["--version"],
    "postgres_client_18_missing",
  );
  const psqlVersion = verifyPsqlVersion(psqlResult.stdout, packageVersion);
  const canonical = await realpath(executable);
  const identity = await inspectExecutable(canonical);
  refuse(
    identity.uid !== 0 ||
      identity.gid !== 0 ||
      (identity.mode & 0o022) !== 0 ||
      (identity.mode & 0o111) === 0,
    "postgres_client_identity_untrusted",
  );
  return Object.freeze({
    evidence: Object.freeze({
      aptIsolation: Object.freeze({
        archivesPath: apt.archivesPath,
        listsPath: apt.listsPath,
        sourceListPath: apt.sourceListPath,
      }),
      aptSource: apt.aptSource,
      binaryPath: canonical,
      binarySha256: identity.sha256,
      officialRepositoryKeyFingerprint: POSTGRES_SIGNING_KEY.fingerprint,
      packageName: POSTGRES_CLIENT.packageName,
      packageVersion,
      preinstalled: false,
      psqlVersion,
    }),
    executable: canonical,
    keyPath,
    sourcePath: apt.sourceListPath,
  });
}
