import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const failures = [];

async function source(path) {
  try {
    return await readFile(join(root, path), "utf8");
  } catch {
    failures.push(`missing Phase 8 artifact: ${path}`);
    return "";
  }
}

function requireText(path, value, required) {
  for (const token of required)
    if (!value.includes(token))
      failures.push(`${path} is missing ${JSON.stringify(token)}`);
}

const plan = await source("docs/workload-funnel-architecture-plan.md");
const planDigest = createHash("sha256").update(plan).digest("hex");
if (
  planDigest !==
  "73dffc99721b929e1e2b109d62f38263f433adb9534bb5fa545978a8c851ccdf"
)
  failures.push("architecture plan differs from the checked Phase 8 baseline");

const identityPath =
  "apps/control-service/src/features/authentication/application/durable-service-identity-authority.ts";
requireText(identityPath, await source(identityPath), [
  "authenticatedWrites",
  "multiWriter",
  "identity_authority_incapable",
  "signServiceIdentityActor",
  "trustedActorKeys",
  "node_enrollment_credential_binding_invalid",
  "replayed_node_message",
  "node_boot_epoch_replay",
  "node.capacity.publish",
  "node.result.publish",
]);

requireText(
  "SQLite identity authority",
  await source(
    "apps/control-service/src/features/authentication/adapters/sqlite-service-identity-authority-store.ts",
  ),
  [
    "PRAGMA journal_mode=WAL",
    "PRAGMA synchronous=FULL",
    "node_id TEXT UNIQUE",
    "certificate_fingerprint TEXT NOT NULL UNIQUE",
  ],
);
requireText(
  "Postgres identity authority",
  await source(
    "apps/control-service/src/features/authentication/adapters/postgres-service-identity-authority-store.ts",
  ),
  [
    'backend !== "postgres"',
    "serializableTransactions",
    "credential_identity_reused",
  ],
);

for (const backend of ["store-postgres", "store-sqlite"]) {
  const path = `packages/${backend}/src/features/node-persistence/index.ts`;
  requireText(path, await source(path), [
    "createProvider",
    "createNodeMaintenanceProvider",
    "claimFence",
    "stale_node_maintenance_claim",
    backend === "store-sqlite"
      ? "PRAGMA synchronous=FULL"
      : "serializableTransactions",
  ]);
  const claimsPath = `packages/${backend}/src/features/reconciliation-claims/index.ts`;
  requireText(claimsPath, await source(claimsPath), [
    "Stale reconciliation claim",
    backend === "store-sqlite"
      ? "PRAGMA synchronous=FULL"
      : "serializableTransactions",
  ]);
}

for (const backend of ["store-postgres", "store-sqlite"]) {
  const path = `packages/${backend}/src/features/ownership-transfer-coordinator-persistence/index.ts`;
  const persistence = await source(path);
  requireText(path, persistence, [
    backend === "store-sqlite"
      ? "phase8_control_failover"
      : "PostgresControlFailoverDriver",
    "control_failover",
    "OwnershipTransferCoordinatorStoreTestFake",
  ]);
  if (
    /export function create(?:Postgres|Sqlite)OwnershipTransferCoordinatorStore/u.test(
      persistence,
    )
  )
    failures.push(`${path} exposes a Map-only production persistence name`);
}

requireText(
  "node maintenance drain",
  await source(
    "packages/workload-control/src/features/node-lifecycle/application/node-maintenance-service.ts",
  ),
  [
    "mergeRetainedExecutions",
    "node_execution_proof_invalid",
    "inventoryRevisions.length >= 2",
  ],
);

const failoverPath =
  "packages/workload-control/src/features/ownership-transfer/domain/control-service-failover.ts";
requireText(failoverPath, await source(failoverPath), [
  '"artifact-store"',
  '"node-launcher"',
  '"result-sealer"',
  '"runtime-broker"',
  '"scheduler-gateway"',
  '"complete_tuple"',
  "fingerprintMutationFence",
  "writerIdentity",
  "AuthoritativeFinalAuthorityInventoryReceipt",
]);
requireText(
  "failover coordinator",
  await source(
    "packages/workload-control/src/features/ownership-transfer/application/control-service-failover.ts",
  ),
  [
    "verifyAuthoritativeInventory",
    "failover_authority_inventory_not_authoritative",
    "environment.inventory",
  ],
);

const artifactAuthorityPath =
  "packages/workload-control/src/features/result-management/application/artifact-mutation-authority.ts";
requireText(artifactAuthorityPath, await source(artifactAuthorityPath), [
  "artifact_cross_scope_high_watermark_rejected",
  "artifact_authority_equal_version_mismatch",
  "writerIdentity",
  "artifact_authority_validity_rejected",
  "createDurableArtifactMutationAuthority",
]);
requireText(
  "SQLite artifact authority",
  await source(
    "packages/artifact-store-object/src/features/stage-upload/sqlite-artifact-mutation-authority-store.ts",
  ),
  [
    "PRAGMA synchronous=FULL",
    "artifact_authority_watermark",
    "BEGIN IMMEDIATE",
  ],
);

for (const path of [
  "packages/artifact-store-filesystem/src/features/stage-write/index.ts",
  "packages/artifact-store-filesystem/src/features/retention-delete/index.ts",
  "packages/artifact-store-object/src/features/stage-upload/index.ts",
  "packages/artifact-store-object/src/features/retention-delete/index.ts",
])
  requireText(path, await source(path), ["authority.authorize"]);

const objectStage = await source(
  "packages/artifact-store-object/src/features/stage-upload/index.ts",
);
requireText("artifact object stage", objectStage, [
  "createOnly",
  "finalMutationFencing",
  "scopedCredentials",
  "serverChecksum",
  "verifyPrivilegedSealReceipt",
]);
requireText(
  "privileged seal receipt",
  await source(
    "packages/node-execution/src/features/result-staging-reporting/index.ts",
  ),
  [
    "privilegedSealTupleFingerprint",
    "scopedUploadAuthorityDigest",
    "verifySignature",
  ],
);

const disasterRecoveryPath =
  "packages/workload-control/src/features/workload-lifecycle/application/disaster-recovery.ts";
requireText(disasterRecoveryPath, await source(disasterRecoveryPath), [
  '"restore_quarantine"',
  '"final_authorities_installed"',
  '"erasure_ledger_replayed"',
  '"admission_approved"',
  "canonicalHistoryDigest",
  "disasterRecoveryEffectEvidenceDigest",
  "authorizedSignerKeyIds",
  "completedEffects",
  "revalidatePersistedCompletedEffectEvidence",
]);
requireText(
  "disaster recovery completed-effect receipts",
  await source(
    "packages/workload-control/src/features/workload-lifecycle/application/disaster-recovery-effect-evidence.ts",
  ),
  [
    "signDisasterRecoveryCompletedEffectReceipt",
    "verifyDisasterRecoveryCompletedEffectReceipt",
    "authorizedSignerKeyIds",
    "outputDigest",
  ],
);
requireText(
  "disaster recovery completed-effect validation",
  await source(
    "packages/workload-control/src/features/workload-lifecycle/application/disaster-recovery-evidence-validation.ts",
  ),
  [
    "authorityInventoryEffectReceipt",
    "authorityCloseEffectReceipts",
    "authorityDrainEffectReceipts",
    "authorityInstallEffectReceipts",
    "erasureReplayEffectReceipt",
    "executionReconciliationEffectReceipts",
    "revalidatePersistedCompletedEffectEvidence",
  ],
);

const boundedE2ePath = "tooling/phase8/bounded-synthetic-e2e.test.ts";
requireText(boundedE2ePath, await source(boundedE2ePath), [
  "createPhase1SyntheticService",
  "recordHostSurvivalObservation",
  "mapSystemdExecutionControls",
  "openSqliteNodePersistence",
  "openSqliteArtifactMutationAuthorityStore",
  "exercisedPressureDimensions",
]);
const oldLoadTest = await source(
  "packages/observability/src/features/telemetry-export/tests/phase8-slo-load-chaos.test.ts",
);
if (oldLoadTest.includes("runBoundedSyntheticLoadAndChaos"))
  failures.push("Phase 8 load evidence is still arithmetic-only");

requireText(
  "Phase 8 migration preflight",
  await source("tooling/compatibility/preflight.mjs"),
  [
    "openSqlitePhase8AcknowledgementReplayStore",
    "phase8_writer_epoch_not_fresh",
    "destructiveDatabaseDowngrade",
    "observationEnabled",
    "cancellationEnabled",
  ],
);

const sloPath =
  "packages/observability/src/features/telemetry-export/application/production-slos.ts";
requireText(sloPath, await source(sloPath), [
  '"host-control-p99-under-load"',
  '"stale-mutation-safety"',
  '"backup-history-preservation"',
]);

const deploymentPath =
  "docs/operations/phase8-hosted-agent-ops-deployment-contract.json";
try {
  const deployment = JSON.parse(await source(deploymentPath));
  if (
    deployment.productionStartsEnabled !== false ||
    deployment.privilegedStartsEnabled !== false ||
    deployment.syntheticFixturesOnly !== true ||
    deployment.externalRepositoryMutationAllowed !== false
  )
    failures.push("Phase 8 deployment contract broadens production authority");
} catch {
  failures.push("Phase 8 deployment contract is not valid JSON");
}

const rehearsalPath =
  "docs/operations/phase8-synthetic-rehearsal-evidence.json";
try {
  const rehearsal = JSON.parse(await source(rehearsalPath));
  if (
    rehearsal.deployment?.productionStartsEnabled !== false ||
    rehearsal.deployment?.privilegedStartsEnabled !== false ||
    rehearsal.deployment?.syntheticFixturesOnly !== true ||
    rehearsal.deployment?.externalRepositoryMutationAllowed !== false
  )
    failures.push("Phase 8 rehearsal evidence broadens production authority");
} catch {
  failures.push("Phase 8 rehearsal evidence is not valid JSON");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "Phase 8 production hardening architecture check passed (plan, identity, failover, maintenance, artifacts, DR, SLOs, deployment)",
  );
}
