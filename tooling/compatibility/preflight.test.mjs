import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  REQUIRED_COMPATIBILITY_COMPONENTS,
  rollingMigrationPreflight,
  verifyCompatibilityManifest,
} from "./preflight.mjs";

const now = 1_783_900_801_000;

function signedManifests() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trust = {
    keys: [
      {
        algorithm: "ed25519",
        keyId: "test-release-key",
        notAfter: now + 100_000,
        notBefore: now - 1000,
        publicKeySpki: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64"),
      },
    ],
  };
  function manifest(releaseId, databaseReadable, databaseWritable) {
    const components = Object.fromEntries(
      REQUIRED_COMPATIBILITY_COMPONENTS.map((component) => [
        component,
        {
          readable:
            component === "databaseSchema"
              ? databaseReadable
              : { maximum: 1, minimum: 1 },
          writable:
            component === "databaseSchema"
              ? databaseWritable
              : { maximum: 1, minimum: 1 },
        },
      ]),
    );
    const unsigned = {
      components,
      executionTicketKeyIds: ["ticket-key-common"],
      expiresAt: now + 100_000,
      hyperqueue: { enabled: false, exactVersion: null },
      issuedAt: now - 1000,
      manifestVersion: 1,
      privilegedStartsEnabled: false,
      productionStartsEnabled: false,
      releaseId,
      signature: {
        algorithm: "ed25519",
        keyId: "test-release-key",
        value: "",
      },
      systemdPropertyProfiles: ["profile-v1"],
    };
    return {
      ...unsigned,
      signature: {
        ...unsigned.signature,
        value: sign(
          null,
          Buffer.from(canonicalJson(unsigned), "utf8"),
          privateKey,
        ).toString("base64"),
      },
    };
  }
  return {
    manifests: [
      manifest(
        "old-release",
        { maximum: 2, minimum: 1 },
        { maximum: 2, minimum: 1 },
      ),
      manifest(
        "new-release",
        { maximum: 3, minimum: 1 },
        { maximum: 3, minimum: 2 },
      ),
    ],
    trust,
  };
}

function input(mode = "upgrade") {
  const signed = signedManifests();
  return {
    activeTickets: [{ keyId: "ticket-key-common", version: 1 }],
    databaseSchemaVersion: 2,
    manifests: signed.manifests,
    migration: {
      backfillCheckpoint: 42,
      backfillResumable: true,
      lockTimeoutMs: 1000,
      oldBinaryPresent: true,
      retainedReplayRequiresOldSchema: true,
      rollbackWaitComplete: false,
      stage: "dual_write",
      statementTimeoutMs: 10_000,
    },
    mode,
    now,
    offlineSupportedManifests: [],
    queuedEvents: [{ schemaVersion: 1 }],
    queuedTickets: [],
    retainedReplayEvents: [{ schemaVersion: 1 }],
    rollbackManifests: [signed.manifests[0]],
    trust: signed.trust,
  };
}

describe("Phase 5 compatibility manifests and rolling migration preflight", () => {
  it("selects only the read/write intersection across actual mixed releases", () => {
    const result = rollingMigrationPreflight(input());
    expect(result.status).toBe("compatible");
    expect(result.componentIntersections.databaseSchema.writable).toEqual([2]);
    expect(result.emitEventSchemaVersion).toBe(1);
  });

  it("checks queued events, active tickets, and rollback releases rather than binaries alone", () => {
    expect(() =>
      rollingMigrationPreflight({
        ...input(),
        queuedEvents: [{ schemaVersion: 2 }],
      }),
    ).toThrow("replay_event_schema_incompatible");
    expect(() =>
      rollingMigrationPreflight({
        ...input(),
        activeTickets: [{ keyId: "retired-key", version: 1 }],
      }),
    ).toThrow("ticket_schema_incompatible");
    expect(() =>
      rollingMigrationPreflight({
        ...input(),
        retainedReplayEvents: [{ schemaVersion: 2 }],
      }),
    ).toThrow("replay_event_schema_incompatible");
    expect(() =>
      rollingMigrationPreflight({
        ...input(),
        queuedTickets: [{ keyId: "retired-key", version: 1 }],
      }),
    ).toThrow("ticket_schema_incompatible");
  });

  it("blocks destructive contract and rollback until bounded migration and effect-freeze evidence is complete", () => {
    expect(() =>
      rollingMigrationPreflight({
        ...input(),
        migration: { ...input().migration, stage: "contract" },
      }),
    ).toThrow("schema_contract_window_open");
    expect(() => rollingMigrationPreflight(input("rollback"))).toThrow(
      "rollback_effect_freeze_incomplete",
    );
    expect(
      rollingMigrationPreflight({
        ...input("rollback"),
        rollbackFreeze: {
          closedGates: ["process_start", "automatic_retry", "result_delete"],
          finalAuthorityAcknowledgements: [
            {
              authorityId: "synthetic-launcher",
              authorityKind: "process_owner",
              durable: true,
              gateRevision: 9,
            },
            {
              authorityId: "synthetic-dispatcher",
              authorityKind: "retry_gateway",
              durable: true,
              gateRevision: 9,
            },
            {
              authorityId: "synthetic-result-sealer",
              authorityKind: "result_sealer",
              durable: true,
              gateRevision: 9,
            },
          ],
          gateRevision: 9,
        },
      }).status,
    ).toBe("compatible");
  });

  it("verifies the checked-in signed manifest with starts disabled", async () => {
    const root = join(import.meta.dirname, "../..");
    const manifest = JSON.parse(
      await readFile(
        join(root, "docs/operations/compatibility-manifest.phase5.json"),
        "utf8",
      ),
    );
    const trust = JSON.parse(
      await readFile(
        join(root, "docs/operations/compatibility-trust.json"),
        "utf8",
      ),
    );
    expect(verifyCompatibilityManifest(manifest, trust, now)).toMatchObject({
      privilegedStartsEnabled: false,
      productionStartsEnabled: false,
    });
  });
});
