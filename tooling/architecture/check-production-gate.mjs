import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const failures = [];

async function source(path) {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    failures.push(`missing production gate artifact: ${path}`);
    return "";
  }
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

const plan = await source("docs/workload-funnel-architecture-plan.md");
if (
  createHash("sha256").update(plan).digest("hex") !==
  "63d0945eedc7884f4419597cb4e19c2c541b103f0458c011d557b24e4f1bccbf"
)
  failures.push("architecture plan differs from the production gate baseline");

const manifest = JSON.parse(await source("package.json"));
if (
  manifest.scripts?.["production-gate:host"] !==
  "node tooling/production-gate/run.mjs"
)
  failures.push("manual production gate script is missing or not exact");
for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
  if (
    name !== "production-gate:host" &&
    /production-gate\/run\.mjs/u.test(command)
  )
    failures.push(`ordinary script ${name} invokes the real-host gate`);
}

for (const area of ["apps", "packages"]) {
  for (const path of await files(join(root, area))) {
    if (![".ts", ".js", ".mjs", ".json"].includes(extname(path))) continue;
    const value = await readFile(path, "utf8");
    if (value.includes("tooling/production-gate"))
      failures.push(`${relative(root, path)} imports real-host harness code`);
  }
}

for (const path of await files(join(root, "tooling"))) {
  if (!/test|spec/u.test(path)) continue;
  const value = await readFile(path, "utf8");
  if (/production-gate\/run\.mjs/u.test(value))
    failures.push(`${relative(root, path)} imports the manual gate entrypoint`);
}

const runner = await source("tooling/production-gate/command-runner.mjs");
for (const token of [
  "execFile",
  "MINIMAL_COMMAND_ENVIRONMENT",
  "reviewedExecutables",
  "shell: false",
  "timeout",
  "maxBuffer",
])
  if (!runner.includes(token))
    failures.push(`bounded command runner is missing ${token}`);
if (/\bexec\s*\(/u.test(runner) || runner.includes("shell: true"))
  failures.push("production gate permits shell execution");

const gate = await source("tooling/production-gate/run.mjs");
if (
  gate.indexOf("config = parseManualGateArguments") >
    gate.indexOf("new BoundedCommandRunner") ||
  !gate.includes("createOwnedSandbox")
)
  failures.push(
    "manual attestation and sandbox admission do not precede host calls",
  );
if (/writeFile\([^)]*\/sys\/fs\/cgroup/u.test(gate))
  failures.push("manual gate writes cgroupfs directly");
for (const blocker of [
  "ambiguous_submit_lookup_unsupported",
  "compatibility_fixture_is_not_production_provider_approval",
  "project_quota_application_adapter_missing",
  "real_async_postgres_lifecycle_adapter_missing",
])
  if (!gate.includes(blocker))
    failures.push(`manual gate omits production-closure blocker ${blocker}`);

const attestation = await source("tooling/production-gate/attestation.mjs");
for (const token of [
  "ARCHITECTURE_PLAN_SHA256",
  "GATE_SANDBOX_PARENT",
  "review_manifest_file_inventory_invalid",
  "review_manifest_host_identity_mismatch",
  "runtime_module_resolution_untrusted",
  "ReviewedExecutableSet",
])
  if (!attestation.includes(token))
    failures.push(`reviewed host admission is missing ${token}`);

const ledger = await source("tooling/production-gate/resource-ledger.mjs");
for (const token of [
  "descriptor.sync()",
  "syncDirectory",
  'state: "prepared"',
  'state = "uncertain"',
  "recover()",
  "cleanup_ledger_reopen_mismatch",
])
  if (!ledger.includes(token))
    failures.push(`durable cleanup ledger is missing ${token}`);

const docker = await source("tooling/production-gate/docker-plan.mjs");
for (const token of [
  "--pull=never",
  "--memory-swap",
  "--pids-limit",
  "--device-read-bps",
  "--device-write-bps",
  "--platform=linux/amd64",
  "--read-only",
  "POSTGRES_PASSWORD_FILE",
  "size=536870912",
  "bind-propagation=rprivate",
  "POSTGRES_SOCKET_TMPFS_OPTIONS",
  "unix_socket_directories=",
  "temp_file_limit=16MB",
  "--internal",
  "MINIO_SUPERVISOR_ENTRYPOINT",
  '"--entrypoint"',
])
  if (!docker.includes(token)) failures.push(`Docker plan is missing ${token}`);
if (
  !docker.includes(
    'export const MINIO_SUPERVISOR_ENTRYPOINT = Object.freeze(["/bin/sh"]);',
  ) ||
  !docker.includes(
    "export const MINIO_SUPERVISOR_COMMAND = Object.freeze([\n  MINIO_SUPERVISOR_DESTINATION,",
  ) ||
  docker.includes("docker-entrypoint.sh")
)
  failures.push("Docker plan does not bypass the MinIO image wrapper exactly");
if (/^ {4}"(?:--publish|-p)",/mu.test(docker))
  failures.push("Docker plan permits host port publication");
if (!docker.includes('"--env-file"'))
  failures.push("Docker plan does not explicitly refuse env-file metadata");

const bounded = await source(
  "tooling/production-gate/bounded-host-process.mjs",
);
for (const token of [
  "AmbientCapabilities=",
  "CapabilityBoundingSet=",
  "DevicePolicy=closed",
  "PrivateNetwork=yes",
  "ProtectSystem=strict",
  "workload-funnel-synthetic",
  "exactBoundedHostPropertiesObserved",
])
  if (!bounded.includes(token))
    failures.push(`bounded host unit is missing ${token}`);

const dockerRuntime = await source(
  "tooling/production-gate/docker-runtime.mjs",
);
for (const token of [
  "inspectContainerConfinement",
  "inspectClientConfinement",
  "docker_container_metadata_contains_secret",
  "MINIO_SUPERVISOR_COMMAND[0]",
  "MINIO_SUPERVISOR_ENTRYPOINT",
  "container?.Cmd",
  "container?.Entrypoint",
  "exactMinioCredentialFileEnvironment",
  '"MINIO_ROOT_PASSWORD_FILE=/run/secrets/minio-root-password"',
  '"MINIO_ROOT_USER_FILE=/run/secrets/minio-root-user"',
  "/^MINIO_ROOT_(?:PASSWORD|USER)=/u",
  "ReadonlyRootfs",
  "no-new-privileges",
])
  if (!dockerRuntime.includes(token))
    failures.push(`Docker runtime verification is missing ${token}`);

const postgres = await source("tooling/production-gate/postgres-probe.mjs");
for (const token of [
  '"before_commit"',
  '"after_commit"',
  "pg_stat_activity",
  "postCommitPersistedAfterRestart: true",
  "parsePostgresCanonicalIdentity",
  "proveConcurrentPostgresReplay",
  '"--quiet"',
  '"VERBOSITY=verbose"',
  "PostgresSerializationFailure",
  "postgresCommandError",
  'error?.code !== "40001"',
  'output.endsWith("\\n")',
  "return result.stdout;",
  "crashServer",
])
  if (!postgres.includes(token))
    failures.push(`Postgres crash proof is missing ${token}`);
if (
  postgres.includes("UNION ALL SELECT workload_id FROM") ||
  !postgres.includes("UNION SELECT workload_id FROM") ||
  postgres.includes("LIMIT 1;")
)
  failures.push("Postgres replay identity is not canonically deduplicated");
const postgresRegression = await source(
  "tooling/production-gate/postgres-probe.test.mjs",
);
for (const token of [
  "BEGIN\\nSET\\nworkload\\nCOMMIT",
  "suppresses real multi-statement psql command statuses",
  "ERROR:  40001:",
  "does not retry a non-serialization psql failure",
  "foreign-workload\\n",
])
  if (!postgresRegression.includes(token))
    failures.push(`Postgres real-output regression is missing ${token}`);

for (const token of [
  "crashAndRestart",
  '"--signal=KILL"',
  'exitCode !== "137"',
  "docker_sigkill_crash_unproven",
])
  if (!dockerRuntime.includes(token))
    failures.push(`Postgres server crash runtime is missing ${token}`);

const objectBootstrap = await source(
  "tooling/production-gate/fixtures/minio-bootstrap.sh",
);
if (
  !objectBootstrap.includes(
    '/bin/cat "$1" | /usr/bin/mc admin user add gate',
  ) ||
  /admin user add gate "\$[^" ]+"/u.test(objectBootstrap)
)
  failures.push("MinIO bootstrap exposes generated credentials through argv");

const object = await source("tooling/production-gate/object-contract.mjs");
for (const token of [
  "credentialEnforcedImmutability: false",
  "uploadCredentialCanOverwrite",
  "overwriteChangedServerChecksum",
  "canOverwrite: true",
])
  if (!object.includes(token))
    failures.push(`object-store truthfulness is missing ${token}`);

const minioSupervisor = await source(
  "tooling/production-gate/fixtures/minio-supervisor.sh",
);
for (const token of [
  "workload-funnel.minio-supervisor.v1",
  "trap request_restart USR1",
  "/usr/bin/minio",
  "expected_root_user_file=/run/secrets/minio-root-user",
  "expected_root_password_file=/run/secrets/minio-root-password",
  "IFS= read -r root_user",
  "IFS= read -r root_password",
  'MINIO_ROOT_USER="$root_user" MINIO_ROOT_PASSWORD="$root_password"',
])
  if (!minioSupervisor.includes(token))
    failures.push(`MinIO process supervisor is missing ${token}`);
if (
  minioSupervisor.includes('/bin/cat "$expected_root_') ||
  minioSupervisor.includes("set -x")
)
  failures.push("MinIO process supervisor can disclose root credentials");

const minioSupervisorRegression = await source(
  "tooling/production-gate/minio-process-restart.test.mjs",
);
for (const token of [
  "WF_GATE_USER_DIGEST_CAPTURE",
  "WF_GATE_PASSWORD_DIGEST_CAPTURE",
  "syntheticRootUser",
  "syntheticRootPassword",
  "JSON.stringify(createMetadata)",
  "multi-line root-password file",
  "generation: 2",
])
  if (!minioSupervisorRegression.includes(token))
    failures.push(`MinIO credential regression is missing ${token}`);

const minioRestart = await source(
  "tooling/production-gate/minio-process-restart.mjs",
);
for (const token of [
  "restartMinioServerProcess",
  "containerBoundaryStable",
  "serverProcessGenerationChanged",
  "serverProcessPidChanged",
  "readinessAfterRestart",
  "containerConfinementStable",
])
  if (!minioRestart.includes(token))
    failures.push(`MinIO process restart proof is missing ${token}`);
if (
  !gate.includes("restartConfinedMinio") ||
  gate.includes("docker.restart(objectName)")
)
  failures.push("manual gate does not use the confined MinIO process restart");

const systemdProbe = await source(
  "tooling/production-gate/systemd-capability-probe.mjs",
);
if (
  !systemdProbe.includes("systemdAnalyzeExecutable") ||
  !systemdProbe.includes('"--property=Version"') ||
  !systemdProbe.includes('"verify"') ||
  systemdProbe.includes("syntheticDisposableLinuxProbe")
)
  failures.push("systemd capability evidence is not a real non-mutating probe");

const pressureFixture = await source(
  "tooling/production-gate/fixtures/pressure-load.mjs",
);
for (const token of ['"cpu"', '"memory"', '"io"', '"disk"', '"inodes"'])
  if (!pressureFixture.includes(token))
    failures.push(`mixed pressure fixture is missing ${token}`);

const order = await source(
  "packages/scheduler-hyperqueue/src/features/dispatch-observation/filesystem-observation-order.ts",
);
for (const token of ["fsyncSync", "previousDigest", "restart_durable"])
  if (!order.includes(token))
    failures.push(`HyperQueue durable ordering is missing ${token}`);

const dispatchObservationProvider = await source(
  "packages/scheduler-hyperqueue/src/features/dispatch-observation/index.ts",
);
const workerInventoryProvider = await source(
  "packages/scheduler-hyperqueue/src/features/worker-inventory/index.ts",
);
const cancellationProvider = await source(
  "packages/scheduler-hyperqueue/src/features/dispatch-cancellation/index.ts",
);
for (const [name, provider] of [
  ["dispatch observation", dispatchObservationProvider],
  ["worker inventory", workerInventoryProvider],
  ["cancel re-observation", cancellationProvider],
])
  if (
    !provider.includes("restart_durable") ||
    (name === "cancel re-observation" &&
      !provider.includes("observationOrderDurability"))
  )
    failures.push(`HyperQueue ${name} provider permits volatile ordering`);
if (cancellationProvider.includes("observeCancellation"))
  failures.push(
    "HyperQueue cancellation uses an unordered observation side contract",
  );

const hq = await source("tooling/production-gate/constants.mjs");
if (
  !hq.includes("0.26.2") ||
  !hq.includes(
    "e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5",
  )
)
  failures.push("official HyperQueue release pin is not exact");

const deployment = JSON.parse(
  await source(
    "docs/operations/phase8-hosted-agent-ops-deployment-contract.json",
  ),
);
if (
  deployment.productionStartsEnabled !== false ||
  deployment.privilegedStartsEnabled !== false
)
  failures.push(
    "existing deployment contract enables production or privileged starts",
  );

const schema = JSON.parse(
  await source(
    "docs/operations/disposable-host-production-readiness-gate.schema.json",
  ),
);
if (
  schema.properties?.productionStartsEnabled?.const !== false ||
  schema.properties?.privilegedStartsEnabled?.const !== false ||
  schema.properties?.syntheticEvidenceAcceptedForRealFields?.const !== false
)
  failures.push("production gate evidence schema is not fail-closed");

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else process.stdout.write("Production gate architecture checks passed.\n");
