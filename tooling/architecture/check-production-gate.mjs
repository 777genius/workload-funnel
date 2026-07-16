import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath, URL } from "node:url";

import {
  PRESSURE_FIXTURE_CPU_WORKER_COUNT,
  PRESSURE_FIXTURE_MEMORY_TARGET,
} from "../production-gate/pressure-fixture-protocol.mjs";

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
  "object_provider_create_only_credential_unsupported",
])
  if (!gate.includes(blocker))
    failures.push(`manual gate omits production-closure blocker ${blocker}`);

const projectQuotaGate = [
  gate,
  await source("tooling/production-gate/systemd-capability-probe.mjs"),
  await source("tooling/production-gate/systemd-contract.mjs"),
].join("\n");
for (const evidence of [
  "projectQuotaMutatingProbe",
  "project_quota_capability_not_proven",
  "projectQuotaApplied",
])
  if (!projectQuotaGate.includes(evidence))
    failures.push(`manual gate omits project-quota evidence ${evidence}`);

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
  "bounded_host_process_cancel_identity_unproven",
  "confinedCancellationPerformed: true",
  "PRESSURE_RUNTIME_MAX_SEC_RANGE",
  "bounded_host_process_stop_identity_unproven",
  "bounded_host_process_stop_uncertain",
  "runtimeMaxSec ?? DEFAULT_RUNTIME_MAX_SEC",
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
  "wait_event_type",
  "backend_xid IS NULL",
  "postgres_crash_window_mismatch",
  "postgres_crash_client_exited_before_window",
])
  if (!postgres.includes(token))
    failures.push(`Postgres crash proof is missing ${token}`);
if (
  postgres.includes("UNION ALL SELECT workload_id FROM") ||
  !postgres.includes("UNION SELECT workload_id FROM") ||
  postgres.includes("LIMIT 1;")
)
  failures.push("Postgres replay identity is not canonically deduplicated");
if (postgres.includes("query LIKE '%pg_sleep%'"))
  failures.push(
    "Postgres crash synchronization relies on truncated query text",
  );
const postgresRegression = await source(
  "tooling/production-gate/postgres-probe.test.mjs",
);
for (const token of [
  "BEGIN\\nSET\\nworkload\\nCOMMIT",
  "suppresses real multi-statement psql command statuses",
  "ERROR:  40001:",
  "does not retry a non-serialization psql failure",
  "foreign-workload\\n",
  "actual orchestration path",
  "long-query crash windows",
  "crash client that exits before its window",
])
  if (!postgresRegression.includes(token))
    failures.push(`Postgres real-output regression is missing ${token}`);

const postgresStage = await source(
  "tooling/production-gate/postgres-stage.mjs",
);
for (const token of [
  "postgresCrashClientEvidence",
  "clientConnectionTerminated: true",
  "clientSignal: null",
])
  if (!postgresStage.includes(token))
    failures.push(`Postgres crash orchestration is missing ${token}`);

const postgresAdapter = await source(
  "tooling/production-gate/postgres-adapter-probe.mjs",
);
for (const token of [
  "createPostgresLifecycleDatabase",
  "migratePostgresLifecycleSchema",
  '"before_commit"',
  '"after_commit"',
  "postgres_lifecycle_idempotency_conflict",
  "postgres_lifecycle_conflict",
  "postgres_lifecycle_pool_timeout",
  "queryTimeoutProven: true",
  "transactionLockTraceProven: true",
  "postgres_migration_corrupt",
  "credentialRedactionProven: true",
  "deterministicShutdownProven: true",
  "callerScopeAuthorizationProven: true",
  "callerScopeDelimiterAndTenantIsolationProven: true",
  "callerAbortAfterCommitReconciled: true",
  "erasureTupleIdempotencyAndTenantIsolationProven: true",
  "lifecycleInputValidationProven: true",
  'database.driverVersion === "8.22.0"',
])
  if (!postgresAdapter.includes(token))
    failures.push(`Postgres adapter gate is missing ${token}`);
const postgresManifest = JSON.parse(
  await source("packages/store-postgres/package.json"),
);
if (
  postgresManifest.dependencies?.pg !== "8.22.0" ||
  postgresManifest.devDependencies?.["@types/pg"] !== "8.20.0" ||
  postgresManifest.dependencies?.postgres !== undefined
)
  failures.push(
    "Postgres adapter must pin official pg@8.22.0 and @types/pg@8.20.0",
  );
const lockfile = await source("pnpm-lock.yaml");
const postgresImporterStart = lockfile.indexOf("  packages/store-postgres:\n");
const postgresImporterEnd = lockfile.indexOf(
  "\n  packages/",
  postgresImporterStart + 1,
);
const postgresImporter = lockfile.slice(
  postgresImporterStart,
  postgresImporterEnd,
);
if (
  postgresImporterStart < 0 ||
  !postgresImporter.includes(
    "      pg:\n        specifier: 8.22.0\n        version: 8.22.0",
  ) ||
  !postgresImporter.includes(
    "      '@types/pg':\n        specifier: 8.20.0\n        version: 8.20.0",
  )
)
  failures.push(
    "Postgres adapter lockfile must pin pg@8.22.0 and @types/pg@8.20.0",
  );
const postgresComposition = await source(
  "apps/control-service/src/generated/composition.control-postgres.ts",
);
for (const token of [
  "createPostgresLifecycleDatabase",
  "migratePostgresLifecycleSchema",
  "createAsyncWorkloadLifecycleService",
  "productionStartsEnabled = false",
  'throw new Error("production_starts_disabled")',
])
  if (!postgresComposition.includes(token))
    failures.push(`Postgres production composition is missing ${token}`);
if (
  postgresComposition.includes("createSyntheticDatabase") ||
  /\bMap\b/u.test(postgresComposition)
)
  failures.push("Postgres production composition uses synthetic state");

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
  "uploadCredentialCanOverwrite: true",
  "overwriteChangedServerChecksum: true",
  "overwriteUsedOriginalCredential: true",
  "canOverwrite: true",
  'Action: ["s3:PutObject"]',
  "Resource: [uploadResource]",
  '"--if-none-match"',
  '"object_gate_unconditional_overwrite_failed"',
])
  if (!object.includes(token))
    failures.push(`object-store truthfulness is missing ${token}`);
for (const token of [
  "credentialEnforcedImmutability: true",
  '"s3:if-none-match"',
  '"x-amz-content-sha256"',
  "ExistingObjectTag",
  "dropUploadAuthority",
  "uploadAuthorityDrop",
  "minio-admin-policy-detach",
])
  if (object.includes(token))
    failures.push(
      `object-store probe retains rejected claim or policy ${token}`,
    );
if ((object.match(/client\.putIfAbsent\(/gu) ?? []).length !== 1)
  failures.push(
    "object-store probe does not perform exactly one conditional upload",
  );

const objectFixtureBootstrap = await source(
  "tooling/production-gate/object-fixture-bootstrap.mjs",
);
for (const token of [
  "dropObjectUploadAuthority",
  '"detach-policy"',
  '"verify-policy-detached"',
  "minio-admin-policy-detach",
])
  if (objectFixtureBootstrap.includes(token) || objectBootstrap.includes(token))
    failures.push(`rejected object upload revocation remains: ${token}`);
for (const token of [
  "object_provider_create_only_credential_unsupported",
  "evidence.credentialEnforcedImmutability === false",
  "evidence.deleteIdentityDistinct === true",
  "evidence.uploadCredentialCanOverwrite === true",
  "evidence.overwriteChangedServerChecksum === true",
  "evidence.overwriteUsedOriginalCredential === true",
  "evidence.exactProviderIdentity.compatibilityOnly === true",
  "evidence.exactProviderIdentity.productionProviderApproved === false",
])
  if (!gate.includes(token))
    failures.push(`manual gate create-only blocker is missing ${token}`);
for (const token of [
  "adminAuthorityAccessKeyId: rootAccess",
  "dropUploadAuthority:",
  "dropObjectUploadAuthority",
  "evidence.uploadAuthorityDrop",
])
  if (gate.includes(token))
    failures.push(`manual gate retains rejected upload revocation: ${token}`);

const objectRegression = await source(
  "tooling/production-gate/production-gate-object.test.mjs",
);
for (const token of [
  "credentialEnforcedImmutability: false",
  "uploadCredentialCanOverwrite: true",
  "overwriteChangedServerChecksum: true",
  "same credential can unconditionally overwrite the exact key",
  "object_gate_unconditional_overwrite_failed",
  "object_gate_server_checksum_mismatch",
  "puts[0][2].environment).toBe(puts[1][2].environment",
])
  if (!objectRegression.includes(token))
    failures.push(
      `object overwrite truthfulness regression is missing ${token}`,
    );

const productionGateRunbook = await source(
  "docs/operations/disposable-host-production-readiness-gate.md",
);
for (const token of [
  "s3:if-none-match",
  "x-amz-content-sha256",
  "ExistingObjectTag",
  "object_provider_create_only_credential_unsupported",
])
  if (!productionGateRunbook.includes(token))
    failures.push(
      `object provider limitation documentation is missing ${token}`,
    );

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
  '[ "$restart_requested" = true ] || [ "$stop_requested" = true ]',
  'kill -0 "$server_pid"',
])
  if (!minioSupervisor.includes(token))
    failures.push(`MinIO process supervisor is missing ${token}`);
if (
  minioSupervisor.includes('/bin/cat "$expected_root_') ||
  minioSupervisor.includes("set -x")
)
  failures.push("MinIO process supervisor can disclose root credentials");
if (
  minioSupervisor.includes("restart_requested=true\n  stop_server") ||
  minioSupervisor.includes("stop_requested=true\n  stop_server")
)
  failures.push("MinIO signal handler performs a racy child transition");
if (/(?:^|[ \t])\/(?:usr\/)?bin\/kill\b/mu.test(minioSupervisor))
  failures.push("MinIO supervisor uses a forbidden absolute kill executable");

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
  "interrupted wait and racing USR1",
  "never accepts a container stop",
  "forbids both absolute kill paths",
  "passes the exact positive supervisor PID",
  "rejects supervisor PID injection",
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
  '"exec"',
  'MINIO_SIGNAL_SHELL = "/bin/sh"',
  "MINIO_SIGNAL_SCRIPT = 'kill -USR1 \"$1\"'",
  "MINIO_SIGNAL_SCRIPT,",
  "MINIO_SIGNAL_ARGV0,",
])
  if (!minioRestart.includes(token))
    failures.push(`MinIO process restart proof is missing ${token}`);
if (minioRestart.includes('"kill", "--signal=USR1"'))
  failures.push("MinIO restart signals the container boundary");
if (/\/(?:usr\/)?bin\/kill\b/u.test(minioRestart))
  failures.push("MinIO restart uses a forbidden absolute kill executable");
if (minioRestart.includes("executableProbe"))
  failures.push("MinIO restart performs an unnecessary executable probe");
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
const pressureFixtureProtocol = await source(
  "tooling/production-gate/pressure-fixture-protocol.mjs",
);
for (const token of ['"cpu"', '"memory"', '"io"', '"disk"', '"inodes"'])
  if (!pressureFixture.includes(token))
    failures.push(`mixed pressure fixture is missing ${token}`);
for (const token of [
  "PRESSURE_FIXTURE_READY_SCHEMA",
  "workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT",
  "primedRetainedBytes: MEMORY_PRIMED_CHUNK_COUNT * MEMORY_CHUNK_BYTES",
  "postReadyRetainedBytes:",
  'await allocateChunk(index, "primed")',
  "await markReady()",
  'await allocateChunk(index, "post-ready")',
  "syncedBytes: 8 * 1024 * 1024",
  "writtenBytes: 48 * 1024 * 1024",
  "createdFiles: 3_200",
  "parsePressureFixtureReadiness",
])
  if (!pressureFixtureProtocol.includes(token))
    failures.push(`pressure priming protocol is missing ${token}`);
if (PRESSURE_FIXTURE_CPU_WORKER_COUNT !== 2)
  failures.push("pressure CPU fixture worker count is not exactly two");
if (
  PRESSURE_FIXTURE_MEMORY_TARGET.chunkBytes !== 16 * 1024 * 1024 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.primedChunkCount !== 22 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.primedRetainedBytes !== 352 * 1024 * 1024 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.postReadyChunkCount !== 25 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.postReadyRetainedBytes !== 400 * 1024 * 1024 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.primedRetainedBytes >= 384 * 1024 * 1024 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.postReadyRetainedBytes <= 384 * 1024 * 1024 ||
  PRESSURE_FIXTURE_MEMORY_TARGET.postReadyRetainedBytes >= 512 * 1024 * 1024
)
  failures.push("pressure memory fixture two-stage bounds are not exact");
for (const token of [
  "PRESSURE_FIXTURE_CPU_WORKER_COUNT",
  "length: PRESSURE_FIXTURE_CPU_WORKER_COUNT",
])
  if (!pressureFixture.includes(token))
    failures.push(`pressure CPU fixture is missing protocol-owned ${token}`);

const mixedLoad = await source("tooling/production-gate/mixed-load.mjs");
for (const token of [
  "produceAcceptedWork",
  "measureProtectedControl",
  "Promise.allSettled(workers)",
  "acceptedAfterReopen",
  "sampleCounts",
])
  if (!mixedLoad.includes(token))
    failures.push(`mixed pressure measurement is missing ${token}`);

const pressureStage = await source(
  "tooling/production-gate/pressure-stage.mjs",
);
for (const token of [
  '"cancel-probe"',
  "processManager.cancel(cancellationProbe)",
  "pressureQuiescedAfterPause",
  "realConfinedCancellationObserved",
  "evidence.sampleCounts.cancel >= 100",
  "evidence.sampleCounts.health >= 100",
  "evidence.sampleCounts.status >= 100",
  "evidence.acceptedAfterReopen > 0",
  "maximumIterations: 900",
  "waitForPressureFixtureReadiness",
  "pressureReadiness?.allModesReady === true",
  "PRESSURE_FIXTURE_RUNTIME_MAX_SEC = 75",
  "pressure_fixture_runtime_budget_insufficient",
  "processManager.verify(process)",
  "Promise.allSettled",
  "evidence.maximumObserved.workloadMemoryPsiSome > 0",
])
  if (!pressureStage.includes(token))
    failures.push(`real pressure stage is missing ${token}`);
if (pressureStage.includes("highObservationsToPause"))
  failures.push("real pressure stage overrides strict pause hysteresis");
if (/`cancel-\$\{String\(/u.test(pressureStage))
  failures.push("real pressure stage creates one systemd unit per sample");
for (const token of [
  ".ready-${mode}",
  'if (mode !== "io" && mode !== "memory") await ready()',
  "await runMemoryPressureFixture({",
  "markReady: ready",
])
  if (!pressureFixture.includes(token))
    failures.push(`pressure fixture readiness is missing ${token}`);
for (const token of [
  "encodePressureFixtureReadiness(mode)",
  "await writeCycle();\n  await ready();",
  "await rename(temporary, marker)",
  'parentPort.postMessage("primed")',
])
  if (!pressureFixture.includes(token))
    failures.push(`pressure fixture priming is missing ${token}`);

const hyperQueueContract = await source(
  "tooling/production-gate/hyperqueue-contract.mjs",
);
for (const token of [
  "stopHyperQueueCompatibilityProcesses",
  "if (worker !== undefined) await stopProcess(worker)",
  "await stopProcess(server)",
])
  if (!hyperQueueContract.includes(token))
    failures.push(`HyperQueue ordered cleanup is missing ${token}`);

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
