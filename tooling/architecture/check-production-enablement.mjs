import { readFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";

const root = new URL("../../", import.meta.url);
const failures = [];

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

const compositionSource = JSON.parse(
  await source("tooling/architecture/composition.source.json"),
);
const postgresProfile = compositionSource.profiles.find(
  (profile) => profile.profileId === "control-postgres",
);
const requiredNodeLane = [
  "deterministic_systemd_process_ownership",
  "foreground_runtime_ownership",
  "host_control_typed_broker",
  "pinned_execution_paths",
  "process_tree_cancellation",
  "provider_runtime_execution",
  "result_seal_boundary",
  "scheduler_mutation_gateway",
];
const requiredControlLane = [
  "authenticated_mtls_transport",
  "durable_audit_ledger",
  "durable_command_inbox",
  "durable_namespace_ownership",
  "durable_node_observations",
  "durable_reconciliation",
  "durable_transactional_outbox",
  "immutable_execution_generation_fencing",
  "postgres_atomic_acceptance",
  "postgres_schema_v2",
  "signed_compatibility_manifest",
];
for (const capability of [...requiredControlLane, ...requiredNodeLane])
  if (!postgresProfile?.productionCapabilityRequirements?.includes(capability))
    failures.push(`production capability receipt omits ${capability}`);
if (postgresProfile?.availableCapabilities?.includes("local_dispatch"))
  failures.push(
    "production control profile advertises synthetic local dispatch",
  );

const composition = await source(
  "apps/control-service/src/generated/composition.control-postgres.ts",
);
for (const token of [
  "validateProductionServerConfig",
  "verifyProductionCapabilityReceipt",
  "productionDeploymentConfigDigest",
  "verifyPostgresLifecycleSchema",
  "migrateControlServiceDatabase",
  "control_service_migration_complete",
  "migration.currentVersion !== 2",
  "createAsyncPostgresAuditLedgerStore",
  "createAsyncPostgresCapacityReservationStore",
  "createAsyncPostgresExecutionStore",
  "createAsyncPostgresInboxStore",
  "createAsyncPostgresNamespaceOwnershipStore",
  "createAsyncPostgresNodeObservationStore",
  "createAsyncPostgresOutboxStore",
  "createAsyncPostgresReconciliationStore",
  "production_transport_identity_missing",
  "production_canonical_bundle_corrupt",
  "production_capacity_profile_missing",
  "production_postgres_migration_state_corrupt",
  "production_namespace_writer_fence_missing",
  "productionStartsEnabled: true as const",
  "createProductionNetworkService",
  "await network.close()",
  "await database.close()",
  "O_NOFOLLOW",
  "installProductionSignalHandlers",
])
  if (!composition.includes(token))
    failures.push(`production control composition omits ${token}`);
if (
  composition.includes("productionStartsEnabled = true") ||
  composition.includes("createSyntheticDatabase") ||
  composition.includes("createPhase1SyntheticService")
)
  failures.push(
    "production composition has an unconditional or synthetic start path",
  );
if (
  composition.indexOf("productionStartsEnabled: true as const") <
  composition.indexOf("await assertCanonicalBundleIntegrity();")
)
  failures.push("production start enablement precedes durable startup gates");

const schema = await source(
  "packages/store-postgres/src/features/schema-migrations/control-plane-schema.ts",
);
for (const table of [
  "control_allocation",
  "control_audit",
  "control_capacity",
  "control_execution",
  "control_inbox",
  "control_namespace_ownership",
  "control_node_snapshot",
  "control_observation",
  "control_reconciliation",
  "control_service_identity",
])
  if (!schema.includes(table))
    failures.push(`production migration omits ${table}`);

const executionStore = await source(
  "packages/store-postgres/src/features/execution-persistence/async-postgres-execution-store.ts",
);
for (const token of [
  "takeOwnership",
  "lease_current",
  "postgres_observation_stale_allocation_fence",
  "postgres_observation_stale_writer_epoch",
])
  if (!executionStore.includes(token))
    failures.push(`production execution fencing omits ${token}`);

const postgresIntegration = await source(
  "packages/store-postgres/src/features/workload-persistence/tests/production-control-plane-postgres.integration.test.ts",
);
const migrationIntegration = await source(
  "packages/store-postgres/src/features/schema-migrations/tests/production-postgres-migration.integration.test.ts",
);
const compositionIntegration = await source(
  "apps/control-service/src/features/transport-http/tests/production-composition-postgres.integration.test.ts",
);
for (const [name, implementation] of [
  ["control stores", postgresIntegration],
  ["migration", migrationIntegration],
  ["control composition", compositionIntegration],
])
  for (const token of [
    "WF_CONTROL_POSTGRES_TEST_URL",
    "wf_control_test_",
    "DROP SCHEMA IF EXISTS",
  ])
    if (!implementation.includes(token))
      failures.push(`disposable Postgres ${name} integration omits ${token}`);
for (const token of [
  "postgres_observation_stale_allocation_fence",
  "postgres_lifecycle_pool_timeout",
  "postgres_lifecycle_aborted",
  "postgres_lifecycle_closed",
])
  if (!postgresIntegration.includes(token))
    failures.push(`disposable Postgres control integration omits ${token}`);
for (const token of [
  "postgres_migration_failed",
  "postgres_migration_corrupt",
  "postgres_migration_state_invalid",
  "lifecycleSchemaStatements",
  "verifyPostgresLifecycleSchema",
])
  if (!migrationIntegration.includes(token))
    failures.push(`disposable Postgres migration integration omits ${token}`);
for (const token of [
  "WF_CONTROL_POSTGRES_TEST_TLS_CERT_PATH",
  "WF_CONTROL_POSTGRES_TEST_TLS_KEY_PATH",
  "WF_CONTROL_SERVER_TEST_PORT",
  "requiredProductionCapabilities",
  "productionCapabilitySigningPayload",
  "createControlService",
  "production_namespace_writer_fence_missing",
  "production_transport_identity_missing",
  "service.productionStartsEnabled",
  "service.listen()",
  "service.readiness()",
  "service.close()",
  "schema_migration SET checksum",
])
  if (!compositionIntegration.includes(token))
    failures.push(`production composition integration omits ${token}`);

const acceptance = await source(
  "packages/store-postgres/src/features/workload-persistence/acceptance.ts",
);
const cancellation = await source(
  "packages/store-postgres/src/features/workload-persistence/cancellation.ts",
);
for (const [operation, implementation] of [
  ["acceptance", acceptance],
  ["cancellation", cancellation],
])
  for (const token of ["completeCanonicalInbox", "appendCanonicalAudit"])
    if (!implementation.includes(token))
      failures.push(`${operation} transaction omits ${token}`);

const rootPackage = JSON.parse(await source("package.json"));
if (
  !rootPackage.scripts?.build?.includes("--filter './apps/*'") ||
  rootPackage.scripts.build.includes("apps/operator-cli") ||
  rootPackage.scripts.build.includes("apps/scheduler-mutation-gateway")
)
  failures.push("root build does not discover deployable apps generically");

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `Production enablement architecture check passed (${fileURLToPath(root)})\n`,
  );
}
