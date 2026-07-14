import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  openSqlitePhase8AcknowledgementReplayStore,
  phase8ProductionRehearsalPreflight,
  REQUIRED_COMPATIBILITY_COMPONENTS,
  rollingMigrationPreflight,
  verifyCompatibilityManifest,
} from "./preflight.mjs";

const replayStores = [];
const replayRoots = [];
afterEach(() => {
  for (const store of replayStores.splice(0)) store.close();
  for (const root of replayRoots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

const now = 1_783_900_801_000;
const phase8RehearsalEvidence = JSON.parse(
  await readFile(
    join(
      import.meta.dirname,
      "../../docs/operations/phase8-synthetic-rehearsal-evidence.json",
    ),
    "utf8",
  ),
);

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

describe("Phase 8 hosted operations migration and rollback rehearsal", () => {
  function rehearsal() {
    const base = {
      ...JSON.parse(JSON.stringify(phase8RehearsalEvidence)),
      migration: input(),
    };
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const authorityTrust = {
      keys: [
        {
          algorithm: "ed25519",
          keyId: "phase8-authority-key",
          notAfter: now + 100_000,
          notBefore: now - 1000,
          publicKeySpki: publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
        },
      ],
    };
    const deploymentContractDigest = createHash("sha256")
      .update(canonicalJson(base.deployment))
      .digest("hex");
    const finalAuthorityAcknowledgements =
      base.rollbackFreeze.finalAuthorityAcknowledgements.map(
        (acknowledgement, index) => {
          const unsigned = {
            ...acknowledgement,
            acknowledgementId: `phase8-authority-ack-${String(index)}`,
            cancellationEnabled: true,
            contractVersion: 1,
            deploymentContractDigest,
            destructiveDatabaseDowngrade: false,
            expiresAt: now + 60_000,
            immutableReleaseDigest: base.deployment.immutableReleaseDigest,
            issuedAt: now - 100,
            nonce: `phase8-authority-ack-nonce-${String(index)}`,
            observationEnabled: true,
            releaseId: base.deployment.releaseId,
            signature: {
              algorithm: "ed25519",
              keyId: "phase8-authority-key",
              value: "",
            },
            writerEpoch: 9,
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
        },
      );
    const replayRoot = mkdtempSync(join(tmpdir(), "wf-phase8-preflight-"));
    replayRoots.push(replayRoot);
    const replayStorePath = join(replayRoot, "acknowledgements.sqlite");
    const replayStore =
      openSqlitePhase8AcknowledgementReplayStore(replayStorePath);
    replayStores.push(replayStore);
    return {
      ...base,
      authorityAcknowledgementReplayStore: replayStore,
      authorityTrust,
      replayStorePath,
      rollbackFreeze: {
        ...base.rollbackFreeze,
        finalAuthorityAcknowledgements,
      },
      writerEpoch: { current: 8, target: 9 },
    };
  }

  it("accepts the complete synthetic hosted-agent-ops handoff with starts disabled", () => {
    expect(phase8ProductionRehearsalPreflight(rehearsal())).toMatchObject({
      privilegedStartsEnabled: false,
      productionStartsEnabled: false,
      status: "rehearsal_passed",
    });
  });

  it("rejects missing final authorities, restore gaps, and host-control starvation", () => {
    const base = rehearsal();
    expect(() =>
      phase8ProductionRehearsalPreflight({
        ...base,
        rollbackFreeze: {
          ...base.rollbackFreeze,
          finalAuthorityAcknowledgements:
            base.rollbackFreeze.finalAuthorityAcknowledgements.slice(1),
        },
      }),
    ).toThrow("phase8_authority_inventory_incomplete");
    expect(() =>
      phase8ProductionRehearsalPreflight({
        ...base,
        disasterRecovery: {
          ...base.disasterRecovery,
          acceptedHistoryAfter: 11,
        },
      }),
    ).toThrow("phase8_disaster_recovery_incomplete");
    expect(() =>
      phase8ProductionRehearsalPreflight({
        ...base,
        disasterRecovery: {
          ...base.disasterRecovery,
          externalAcceptanceHighWatermark: 11,
        },
      }),
    ).toThrow("phase8_disaster_recovery_incomplete");
    expect(() =>
      phase8ProductionRehearsalPreflight({
        ...base,
        syntheticLoad: { ...base.syntheticLoad, hostControlP99Ms: 101 },
      }),
    ).toThrow("phase8_load_slo_not_met");
  });

  it("rejects stale/replayed acknowledgements, writer reuse, destructive downgrade, and observe/cancel discontinuity", () => {
    const stale = rehearsal();
    stale.rollbackFreeze.finalAuthorityAcknowledgements[0].expiresAt = now;
    expect(() => phase8ProductionRehearsalPreflight(stale)).toThrow(
      "phase8_authority_acknowledgement_invalid",
    );
    expect(() =>
      phase8ProductionRehearsalPreflight({
        ...rehearsal(),
        writerEpoch: { current: 9, target: 9 },
      }),
    ).toThrow("phase8_writer_epoch_not_fresh");
    expect(() => {
      const unsafe = rehearsal();
      unsafe.deployment.rollback.destructiveDatabaseDowngrade = true;
      phase8ProductionRehearsalPreflight(unsafe);
    }).toThrow("phase8_rollback_guarantees_incomplete");
    expect(() => {
      const discontinuous = rehearsal();
      discontinuous.deployment.rollback.observationAndCancellationRemainEnabled = false;
      phase8ProductionRehearsalPreflight(discontinuous);
    }).toThrow("phase8_rollback_guarantees_incomplete");
    const replayed = rehearsal();
    expect(phase8ProductionRehearsalPreflight(replayed).status).toBe(
      "rehearsal_passed",
    );
    replayed.authorityAcknowledgementReplayStore.close();
    replayStores.splice(
      replayStores.indexOf(replayed.authorityAcknowledgementReplayStore),
      1,
    );
    replayed.authorityAcknowledgementReplayStore =
      openSqlitePhase8AcknowledgementReplayStore(replayed.replayStorePath);
    replayStores.push(replayed.authorityAcknowledgementReplayStore);
    expect(() => phase8ProductionRehearsalPreflight(replayed)).toThrow(
      "phase8_authority_acknowledgement_replayed",
    );
  });
});
