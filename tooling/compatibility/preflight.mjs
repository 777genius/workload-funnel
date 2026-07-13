import { createPublicKey, verify } from "node:crypto";
import { Buffer } from "node:buffer";

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
