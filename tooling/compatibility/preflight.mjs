import { createHash, createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";

export const REQUIRED_COMPATIBILITY_COMPONENTS = Object.freeze([
  "databaseSchema",
  "apiSchema",
  "eventSchema",
  "executionTicket",
  "nodeLauncherLedger",
  "mutationFenceSerializer",
  "mutationFenceFingerprint",
  "schedulerGatewayRegistry",
  "schedulerGatewayWal",
  "schedulerGatewayInstallRpc",
  "resultSealerRegistry",
  "resultSealerWal",
  "resultSealerRpc",
  "systemdPropertyProfile",
  "artifactAdapterContract",
]);

export const MIGRATION_STAGES = Object.freeze([
  "expand",
  "dual_write",
  "backfill",
  "validate",
  "switch_reads",
  "stop_old_writes",
  "rollback_wait",
  "contract",
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([key]) => key !== "signature")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function rangeValues(range) {
  if (
    typeof range !== "object" ||
    range === null ||
    !Number.isSafeInteger(range.minimum) ||
    !Number.isSafeInteger(range.maximum) ||
    range.minimum < 1 ||
    range.maximum < range.minimum
  )
    throw new Error("invalid_compatibility_range");
  if (range.maximum - range.minimum > 1024)
    throw new Error("compatibility_range_too_large");
  return Array.from(
    { length: range.maximum - range.minimum + 1 },
    (_, index) => range.minimum + index,
  );
}

function intersection(sets) {
  const [first, ...rest] = sets;
  return (first ?? []).filter((value) =>
    rest.every((values) => values.includes(value)),
  );
}

export function verifyCompatibilityManifest(manifest, trust, now) {
  if (
    manifest?.manifestVersion !== 1 ||
    typeof manifest.releaseId !== "string" ||
    manifest.releaseId.length < 1 ||
    manifest.releaseId.length > 256 ||
    !Number.isSafeInteger(manifest.issuedAt) ||
    !Number.isSafeInteger(manifest.expiresAt) ||
    !Number.isSafeInteger(now) ||
    manifest.expiresAt <= manifest.issuedAt ||
    now < manifest.issuedAt ||
    now > manifest.expiresAt ||
    manifest.productionStartsEnabled !== false ||
    manifest.privilegedStartsEnabled !== false ||
    typeof manifest.components !== "object" ||
    manifest.components === null ||
    manifest.signature?.algorithm !== "ed25519"
  )
    throw new Error("invalid_compatibility_manifest");
  if (
    JSON.stringify(Object.keys(manifest.components).sort()) !==
    JSON.stringify([...REQUIRED_COMPATIBILITY_COMPONENTS].sort())
  )
    throw new Error("compatibility_component_inventory_mismatch");
  for (const component of REQUIRED_COMPATIBILITY_COMPONENTS) {
    rangeValues(manifest.components[component]?.readable);
    rangeValues(manifest.components[component]?.writable);
  }
  if (
    !Array.isArray(manifest.executionTicketKeyIds) ||
    manifest.executionTicketKeyIds.length < 1 ||
    new Set(manifest.executionTicketKeyIds).size !==
      manifest.executionTicketKeyIds.length ||
    manifest.executionTicketKeyIds.some(
      (keyId) =>
        typeof keyId !== "string" || keyId.length < 1 || keyId.length > 256,
    ) ||
    !Array.isArray(manifest.systemdPropertyProfiles) ||
    manifest.systemdPropertyProfiles.length < 1 ||
    new Set(manifest.systemdPropertyProfiles).size !==
      manifest.systemdPropertyProfiles.length ||
    manifest.systemdPropertyProfiles.some(
      (profile) =>
        typeof profile !== "string" ||
        profile.length < 1 ||
        profile.length > 256,
    ) ||
    typeof manifest.hyperqueue?.enabled !== "boolean" ||
    (manifest.hyperqueue.enabled === false
      ? manifest.hyperqueue.exactVersion !== null
      : typeof manifest.hyperqueue.exactVersion !== "string" ||
        manifest.hyperqueue.exactVersion.length < 1 ||
        manifest.hyperqueue.exactVersion.length > 128)
  )
    throw new Error("invalid_compatibility_manifest_capabilities");
  if (!Array.isArray(trust?.keys))
    throw new Error("compatibility_trust_invalid");
  const trustedKey = trust.keys.find(
    (key) => key.keyId === manifest.signature.keyId,
  );
  if (
    trustedKey === undefined ||
    trustedKey.algorithm !== "ed25519" ||
    now < trustedKey.notBefore ||
    now > trustedKey.notAfter
  )
    throw new Error("compatibility_signing_key_untrusted");
  const publicKey = createPublicKey({
    format: "der",
    key: Buffer.from(trustedKey.publicKeySpki, "base64"),
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(manifest), "utf8"),
      publicKey,
      Buffer.from(manifest.signature.value, "base64"),
    )
  )
    throw new Error("compatibility_signature_invalid");
  return manifest;
}

function validateMigration(migration) {
  const stageIndex = MIGRATION_STAGES.indexOf(migration.stage);
  if (stageIndex < 0) throw new Error("invalid_migration_stage");
  if (
    !Number.isSafeInteger(migration.lockTimeoutMs) ||
    migration.lockTimeoutMs < 1 ||
    migration.lockTimeoutMs > 30_000 ||
    !Number.isSafeInteger(migration.statementTimeoutMs) ||
    migration.statementTimeoutMs < migration.lockTimeoutMs ||
    migration.statementTimeoutMs > 300_000 ||
    migration.backfillResumable !== true ||
    !Number.isSafeInteger(migration.backfillCheckpoint) ||
    migration.backfillCheckpoint < 0
  )
    throw new Error("unsafe_migration_configuration");
  if (
    migration.stage === "contract" &&
    (migration.oldBinaryPresent === true ||
      migration.retainedReplayRequiresOldSchema === true ||
      migration.rollbackWaitComplete !== true)
  )
    throw new Error("schema_contract_window_open");
}

function validateRollbackFreeze(evidence) {
  const required = ["automatic_retry", "process_start", "result_delete"];
  const requiredAuthorityKinds = [
    "process_owner",
    "retry_gateway",
    "result_sealer",
  ];
  if (
    evidence === undefined ||
    !Number.isSafeInteger(evidence.gateRevision) ||
    evidence.gateRevision < 1 ||
    !required.every((gate) => evidence.closedGates?.includes(gate)) ||
    !Array.isArray(evidence.finalAuthorityAcknowledgements) ||
    evidence.finalAuthorityAcknowledgements.length < 1 ||
    evidence.finalAuthorityAcknowledgements.some(
      (ack) =>
        ack.gateRevision !== evidence.gateRevision || ack.durable !== true,
    ) ||
    !requiredAuthorityKinds.every(
      (kind) =>
        evidence.finalAuthorityAcknowledgements.filter(
          (ack) => ack.authorityKind === kind,
        ).length === 1,
    )
  )
    throw new Error("rollback_effect_freeze_incomplete");
}

export function rollingMigrationPreflight(input) {
  if (
    !Array.isArray(input.manifests) ||
    input.manifests.length < 1 ||
    !Array.isArray(input.offlineSupportedManifests) ||
    !Array.isArray(input.rollbackManifests) ||
    !Array.isArray(input.queuedEvents) ||
    !Array.isArray(input.retainedReplayEvents) ||
    !Array.isArray(input.activeTickets) ||
    !Array.isArray(input.queuedTickets)
  )
    throw new Error("compatibility_manifest_missing");
  if (input.mode === "rollback" && input.rollbackManifests.length < 1)
    throw new Error("rollback_manifest_missing");
  const verified = [
    ...input.manifests,
    ...input.offlineSupportedManifests,
    ...input.rollbackManifests,
  ].map((manifest) =>
    verifyCompatibilityManifest(manifest, input.trust, input.now),
  );
  const byRelease = new Map();
  for (const manifest of verified) {
    const prior = byRelease.get(manifest.releaseId);
    if (prior !== undefined && canonicalJson(prior) !== canonicalJson(manifest))
      throw new Error("compatibility_release_id_conflict");
    byRelease.set(manifest.releaseId, manifest);
  }
  const manifests = [...byRelease.values()];
  validateMigration(input.migration);
  if (input.mode === "rollback") validateRollbackFreeze(input.rollbackFreeze);
  const componentIntersections = {};
  for (const component of REQUIRED_COMPATIBILITY_COMPONENTS) {
    const readable = intersection(
      manifests.map((manifest) =>
        rangeValues(manifest.components[component].readable),
      ),
    );
    const producible = intersection([
      ...manifests.map((manifest) =>
        rangeValues(manifest.components[component].writable),
      ),
      ...manifests.map((manifest) =>
        rangeValues(manifest.components[component].readable),
      ),
    ]);
    if (readable.length === 0 || producible.length === 0)
      throw new Error(`mixed_version_incompatible:${component}`);
    componentIntersections[component] = Object.freeze({
      readable: Object.freeze(readable),
      writable: Object.freeze(producible),
    });
  }
  const eventReadable = componentIntersections.eventSchema.readable;
  if (
    [...input.queuedEvents, ...input.retainedReplayEvents].some(
      (event) => !eventReadable.includes(event.schemaVersion),
    )
  )
    throw new Error("replay_event_schema_incompatible");
  const ticketReadable = componentIntersections.executionTicket.readable;
  const trustedTicketKeys = intersection(
    manifests.map((manifest) => manifest.executionTicketKeyIds),
  );
  if (
    [...input.activeTickets, ...input.queuedTickets].some(
      (ticket) =>
        !ticketReadable.includes(ticket.version) ||
        !trustedTicketKeys.includes(ticket.keyId),
    )
  )
    throw new Error("ticket_schema_incompatible");
  const systemdPropertyProfiles = intersection(
    manifests.map((manifest) => manifest.systemdPropertyProfiles),
  );
  if (systemdPropertyProfiles.length === 0)
    throw new Error("systemd_property_profile_incompatible");
  const hyperqueueIdentities = new Set(
    manifests.map((manifest) =>
      JSON.stringify([
        manifest.hyperqueue.enabled,
        manifest.hyperqueue.exactVersion,
      ]),
    ),
  );
  if (hyperqueueIdentities.size !== 1)
    throw new Error("hyperqueue_version_incompatible");
  const database = componentIntersections.databaseSchema;
  if (!database.readable.includes(input.databaseSchemaVersion))
    throw new Error("database_schema_unreadable");
  return Object.freeze({
    contractVersion: "workload-funnel.migration-preflight/v1",
    componentIntersections: Object.freeze(componentIntersections),
    emitEventSchemaVersion: Math.max(
      ...componentIntersections.eventSchema.writable,
    ),
    emitTicketVersion: Math.max(
      ...componentIntersections.executionTicket.writable,
    ),
    systemdPropertyProfiles: Object.freeze(systemdPropertyProfiles),
    releaseIds: Object.freeze(manifests.map((manifest) => manifest.releaseId)),
    status: "compatible",
  });
}

const PHASE8_CLOSED_EFFECT_GATES = Object.freeze([
  "acceptance",
  "admission_reservation",
  "automatic_retry",
  "dispatch_submit",
  "process_start",
  "result_archive",
  "result_delete",
  "result_finalize",
]);

const PHASE8_FINAL_AUTHORITY_KINDS = Object.freeze([
  "artifact-store",
  "node-launcher",
  "result-sealer",
  "runtime-broker",
  "scheduler-gateway",
]);

function requireExactStrings(actual, expected, code) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    JSON.stringify([...new Set(actual)].sort()) !==
      JSON.stringify([...expected].sort())
  )
    throw new Error(code);
}

export function openSqlitePhase8AcknowledgementReplayStore(path) {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA synchronous=FULL");
  database.exec("PRAGMA busy_timeout=5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS phase8_authority_acknowledgement_nonce (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    ) STRICT;
  `);
  return Object.freeze({
    capabilities: Object.freeze({ atomicConsume: true, durable: true }),
    close: () => database.close(),
    consume(nonce, expiresAt) {
      if (
        typeof nonce !== "string" ||
        nonce.length < 16 ||
        !Number.isSafeInteger(expiresAt)
      )
        return false;
      return (
        database
          .prepare(
            "INSERT INTO phase8_authority_acknowledgement_nonce (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING",
          )
          .run(nonce, expiresAt).changes === 1
      );
    },
  });
}

function verifyPhase8AuthorityAcknowledgement(
  acknowledgement,
  trust,
  deployment,
  expectedWriterEpoch,
  now,
) {
  const key = trust?.keys?.find(
    (candidate) => candidate.keyId === acknowledgement?.signature?.keyId,
  );
  const deploymentContractDigest = createHash("sha256")
    .update(canonicalJson(deployment))
    .digest("hex");
  if (
    acknowledgement?.contractVersion !== 1 ||
    typeof acknowledgement.acknowledgementId !== "string" ||
    typeof acknowledgement.nonce !== "string" ||
    acknowledgement.nonce.length < 16 ||
    acknowledgement.releaseId !== deployment.releaseId ||
    acknowledgement.immutableReleaseDigest !==
      deployment.immutableReleaseDigest ||
    acknowledgement.deploymentContractDigest !== deploymentContractDigest ||
    acknowledgement.writerEpoch !== expectedWriterEpoch ||
    acknowledgement.destructiveDatabaseDowngrade !== false ||
    acknowledgement.observationEnabled !== true ||
    acknowledgement.cancellationEnabled !== true ||
    acknowledgement.durable !== true ||
    acknowledgement.completeHighWatermarks !== true ||
    !Number.isSafeInteger(acknowledgement.issuedAt) ||
    !Number.isSafeInteger(acknowledgement.expiresAt) ||
    now < acknowledgement.issuedAt ||
    now >= acknowledgement.expiresAt ||
    acknowledgement.expiresAt - acknowledgement.issuedAt > 5 * 60_000 ||
    acknowledgement.signature?.algorithm !== "ed25519" ||
    key?.algorithm !== "ed25519" ||
    now < key.notBefore ||
    now >= key.notAfter
  )
    throw new Error("phase8_authority_acknowledgement_invalid");
  const publicKey = createPublicKey({
    format: "der",
    key: Buffer.from(key.publicKeySpki, "base64"),
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(acknowledgement), "utf8"),
      publicKey,
      Buffer.from(acknowledgement.signature.value, "base64"),
    )
  )
    throw new Error("phase8_authority_acknowledgement_signature_invalid");
  return acknowledgement.nonce;
}

export function phase8ProductionRehearsalPreflight(input) {
  const migration = rollingMigrationPreflight(input.migration);
  const deployment = input.deployment;
  if (
    deployment?.contractVersion !== "workload-funnel.hosted-ops/v1" ||
    typeof deployment.releaseId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(deployment.immutableReleaseDigest) ||
    deployment.productionStartsEnabled !== false ||
    deployment.privilegedStartsEnabled !== false ||
    deployment.syntheticFixturesOnly !== true ||
    deployment.externalRepositoryMutationAllowed !== false
  )
    throw new Error("unsafe_phase8_deployment_contract");
  if (
    deployment.rollback?.destructiveDatabaseDowngrade !== false ||
    deployment.rollback?.requiresFreshWriterEpoch !== true ||
    deployment.rollback?.observationAndCancellationRemainEnabled !== true
  )
    throw new Error("phase8_rollback_guarantees_incomplete");
  requireExactStrings(
    Object.keys(deployment.rollback),
    [
      "destructiveDatabaseDowngrade",
      "observationAndCancellationRemainEnabled",
      "requiresFreshWriterEpoch",
    ],
    "phase8_rollback_guarantees_incomplete",
  );
  requireExactStrings(
    deployment.serviceUsers,
    [
      "workload-funnel-control",
      "workload-funnel-node",
      "workload-funnel-launcher",
      "workload-funnel-result-sealer",
      "workload-funnel-runtime-broker",
      "workload-funnel-scheduler-gateway",
      "workload-funnel-artifact-retention",
    ],
    "phase8_service_identity_separation_incomplete",
  );
  if (
    !Array.isArray(deployment.secretReferences) ||
    deployment.secretReferences.length < 1 ||
    deployment.secretReferences.some(
      (reference) =>
        typeof reference !== "string" ||
        !reference.startsWith("secret-ref:") ||
        reference.includes("="),
    )
  )
    throw new Error("phase8_secret_reference_invalid");

  const identity = input.identity;
  if (
    identity?.durableAuthority !== true ||
    identity.authenticatedWrites !== true ||
    identity.multiWriterCas !== true ||
    identity.replayTestsPassed !== true ||
    identity.publicationAuthorizationTestsPassed !== true ||
    identity.revocationTestsPassed !== true ||
    !Number.isSafeInteger(identity.enrolledNodeCount) ||
    identity.enrolledNodeCount < 1
  )
    throw new Error("phase8_identity_authority_incomplete");

  const freeze = input.rollbackFreeze;
  requireExactStrings(
    freeze?.closedGates,
    PHASE8_CLOSED_EFFECT_GATES,
    "phase8_effect_freeze_incomplete",
  );
  requireExactStrings(
    freeze?.finalAuthorityAcknowledgements?.map(
      (acknowledgement) => acknowledgement.authorityKind,
    ),
    PHASE8_FINAL_AUTHORITY_KINDS,
    "phase8_authority_inventory_incomplete",
  );
  if (
    !Number.isSafeInteger(freeze.gateRevision) ||
    freeze.gateRevision < 1 ||
    freeze.finalAuthorityAcknowledgements.some(
      (acknowledgement) =>
        acknowledgement.durable !== true ||
        acknowledgement.gateRevision !== freeze.gateRevision ||
        !/^fence-v1-[a-f0-9]{64}$/u.test(
          acknowledgement.mutationFenceFingerprint,
        ) ||
        acknowledgement.completeHighWatermarks !== true,
    )
  )
    throw new Error("phase8_authority_acknowledgement_incomplete");

  const currentWriterEpoch = input.writerEpoch?.current;
  const targetWriterEpoch = input.writerEpoch?.target;
  if (
    !Number.isSafeInteger(currentWriterEpoch) ||
    !Number.isSafeInteger(targetWriterEpoch) ||
    targetWriterEpoch !== currentWriterEpoch + 1
  )
    throw new Error("phase8_writer_epoch_not_fresh");
  if (
    input.authorityAcknowledgementReplayStore?.capabilities?.durable !== true ||
    input.authorityAcknowledgementReplayStore.capabilities.atomicConsume !==
      true
  )
    throw new Error("phase8_acknowledgement_replay_store_incapable");
  const acknowledgementNonces = freeze.finalAuthorityAcknowledgements.map(
    (acknowledgement) =>
      verifyPhase8AuthorityAcknowledgement(
        acknowledgement,
        input.authorityTrust,
        deployment,
        targetWriterEpoch,
        input.migration.now,
      ),
  );
  if (new Set(acknowledgementNonces).size !== acknowledgementNonces.length)
    throw new Error("phase8_authority_acknowledgement_replayed");
  if (
    new Set(
      freeze.finalAuthorityAcknowledgements.map(
        (acknowledgement) => acknowledgement.acknowledgementId,
      ),
    ).size !== freeze.finalAuthorityAcknowledgements.length
  )
    throw new Error("phase8_authority_acknowledgement_replayed");

  const recovery = input.disasterRecovery;
  if (
    recovery?.restoreStep !== "admission_approved" ||
    recovery.acceptedHistoryBefore !== recovery.acceptedHistoryAfter ||
    recovery.terminalHistoryBefore !== recovery.terminalHistoryAfter ||
    recovery.canonicalHistoryDigestBefore !==
      recovery.canonicalHistoryDigestAfter ||
    recovery.externalAcceptanceHighWatermark !==
      recovery.recoveredAcceptanceHighWatermark ||
    recovery.externalAuditHighWatermark !==
      recovery.recoveredAuditHighWatermark ||
    recovery.erasureLedgerReplayed !== true ||
    recovery.unknownExecutionCount !== 0
  )
    throw new Error("phase8_disaster_recovery_incomplete");

  const load = input.syntheticLoad;
  if (
    load?.syntheticOnly !== true ||
    !Number.isFinite(load.hostControlP99Ms) ||
    load.hostControlP99Ms > 100 ||
    load.staleExternalEffects !== 0 ||
    load.completedWorkloads < 8 ||
    load.completedWorkloads > 12 ||
    load.maximumBacklog > load.backlogLimit
  )
    throw new Error("phase8_load_slo_not_met");

  if (
    input.nodeMaintenance?.incompleteOperations !== 0 ||
    input.nodeMaintenance.staleTakeoverMutations !== 0 ||
    input.nodeMaintenance.rebootUnknownExecutions !== 0
  )
    throw new Error("phase8_node_maintenance_incomplete");

  for (const acknowledgement of freeze.finalAuthorityAcknowledgements)
    if (
      !input.authorityAcknowledgementReplayStore.consume(
        acknowledgement.nonce,
        acknowledgement.expiresAt,
      )
    )
      throw new Error("phase8_authority_acknowledgement_replayed");

  return Object.freeze({
    contractVersion: "workload-funnel.phase8-rehearsal/v1",
    migration,
    productionStartsEnabled: false,
    privilegedStartsEnabled: false,
    releaseId: deployment.releaseId,
    status: "rehearsal_passed",
  });
}
