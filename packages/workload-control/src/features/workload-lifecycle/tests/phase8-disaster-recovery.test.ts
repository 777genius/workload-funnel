import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openSqliteDisasterRecoveryStore } from "@workload-funnel/store-sqlite/workload-persistence";

import {
  advancePersistedDisasterRecovery,
  assertDisasterRecoveryAdmissionOpen,
  beginPersistedDisasterRecovery,
  canonicalHistoryDigest,
  createWorkloadBackupManifest,
  signDisasterRecoveryCompletedEffectReceipt,
  signDisasterRecoveryEffectReceipt,
  type CanonicalHistoryRecord,
  type DisasterRecoveryCompletedEffectKind,
  type DisasterRecoveryCompletedEffectReceipt,
  type DisasterRecoveryEffectPayload,
  type DisasterRecoveryStep,
} from "../index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "wf-phase8-recovery-"));
  roots.push(root);
  return join(root, "recovery.sqlite");
}

const history: readonly CanonicalHistoryRecord[] = Object.freeze([
  {
    attemptId: "attempt-1",
    canonicalDigest: "accepted-digest-1",
    kind: "accepted",
    runId: "run-1",
    streamSequence: 1,
    workloadId: "workload-1",
  },
  {
    attemptId: "attempt-1",
    canonicalDigest: "terminal-digest-1",
    kind: "terminal",
    runId: "run-1",
    streamSequence: 2,
    workloadId: "workload-1",
  },
]);

function manifest() {
  return createWorkloadBackupManifest({
    acceptanceHighWatermark: 1,
    auditHighWatermark: 2,
    backupId: "backup-phase8-1",
    clusterIncarnation: "cluster-before-restore",
    createdAt: 80,
    databaseSchemaVersion: 2,
    durabilityProfile: "externally_witnessed",
    erasureLedgerHighWatermark: 7,
    history,
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const keys = generateKeyPairSync("ed25519");
const recoverySteps = Object.freeze([
  "restore_quarantine",
  "cluster_authority_rotated",
  "final_authorities_installed",
  "external_inventory_reconciled",
  "projections_rebuilt",
  "erasure_ledger_replayed",
  "executions_reconciled",
  "nodes_reenrolled",
  "admission_approved",
] as const);
const completedEffectKinds = Object.freeze([
  "authority_close_completed",
  "authority_drain_completed",
  "authority_install_ack_completed",
  "authority_inventory_completed",
  "erasure_replay_completed",
  "execution_reconciliation_completed",
  "external_inventory_reconciled",
  "restore_completed",
] as const satisfies readonly DisasterRecoveryCompletedEffectKind[]);
const completedEffectKeyPairs = new Map(
  completedEffectKinds.map((kind) => [kind, generateKeyPairSync("ed25519")]),
);
const effectTrust = Object.freeze({
  authorizedSignerKeyIds: Object.freeze(
    Object.fromEntries(
      recoverySteps.map((step) => [step, new Set(["recovery-effect-key"])]),
    ) as unknown as Record<DisasterRecoveryStep, ReadonlySet<string>>,
  ),
  completedEffects: Object.freeze({
    authorizedSignerKeyIds: Object.freeze(
      Object.fromEntries(
        completedEffectKinds.map((kind) => [
          kind,
          new Set([`completed-effect-key:${kind}`]),
        ]),
      ) as unknown as Record<
        DisasterRecoveryCompletedEffectKind,
        ReadonlySet<string>
      >,
    ),
    keys: new Map(
      completedEffectKinds.map((kind) => {
        const pair = completedEffectKeyPairs.get(kind);
        if (pair === undefined) throw new Error("completed_effect_key_missing");
        return [`completed-effect-key:${kind}`, pair.publicKey] as const;
      }),
    ),
  }),
  keys: new Map([["recovery-effect-key", keys.publicKey]]),
});

let completedSequence = 0;
function completedEffect(
  operationId: string,
  effectKind: DisasterRecoveryCompletedEffectKind,
  subjectId: string,
  input: Readonly<{
    bindings?: Readonly<Record<string, string | number>>;
    outputDigest?: string;
    relatedSubjectIds?: readonly string[];
  }> = {},
): DisasterRecoveryCompletedEffectReceipt {
  completedSequence += 1;
  const pair = completedEffectKeyPairs.get(effectKind);
  if (pair === undefined) throw new Error("completed_effect_key_missing");
  return signDisasterRecoveryCompletedEffectReceipt(
    {
      bindings: input.bindings ?? Object.freeze({}),
      completedAt: 90,
      contractVersion: 1,
      durableSequence: completedSequence,
      effectKind,
      nonce: `completed-effect-nonce-${String(completedSequence).padStart(8, "0")}`,
      notAfter: 200,
      operationId,
      outputDigest:
        input.outputDigest ??
        digest(`${effectKind}:${subjectId}:${String(completedSequence)}`),
      receiptId: `completed-${effectKind}-${String(completedSequence)}`,
      relatedSubjectIds: input.relatedSubjectIds ?? Object.freeze([]),
      signerKeyId: `completed-effect-key:${effectKind}`,
      subjectId,
    },
    pair.privateKey,
  );
}

const closedGates = Object.freeze([
  "acceptance",
  "admission_reservation",
  "automatic_retry",
  "dispatch_submit",
  "process_start",
  "result_archive",
  "result_delete",
  "result_finalize",
]);
const authorityTargets = Object.freeze([
  "artifact-store:artifact-1:scope-1",
  "node-launcher:launcher-1:scope-1",
  "result-sealer:sealer-1:scope-1",
  "runtime-broker:runtime-1:scope-1",
  "scheduler-gateway:scheduler-1:scope-1",
]);
const executionSubjects = Object.freeze([
  "execution-1:generation-1:allocation-1",
  "execution-2:generation-1:allocation-2",
  "execution-3:generation-1:allocation-3",
]);

function authorityEvidence(operationId: string) {
  const inventoryDigest = digest("complete-authority-inventory");
  const inventory = completedEffect(
    operationId,
    "authority_inventory_completed",
    "authority-inventory-1",
    {
      bindings: { inventoryDigest, targetCount: authorityTargets.length },
      outputDigest: inventoryDigest,
      relatedSubjectIds: authorityTargets,
    },
  );
  const closes = authorityTargets.map((target) =>
    completedEffect(operationId, "authority_close_completed", target, {
      bindings: {
        effectScopeKey: `effect-scope:${target}`,
        inventoryReceiptId: inventory.receiptId,
      },
    }),
  );
  const drains = authorityTargets.map((target, index) => {
    const close = closes[index];
    if (close === undefined) throw new Error("close_receipt_missing");
    return completedEffect(operationId, "authority_drain_completed", target, {
      bindings: { closeReceiptId: close.receiptId },
    });
  });
  const installs = authorityTargets.map((target, index) => {
    const drain = drains[index];
    if (drain === undefined) throw new Error("drain_receipt_missing");
    return completedEffect(
      operationId,
      "authority_install_ack_completed",
      target,
      {
        bindings: {
          drainReceiptId: drain.receiptId,
          highWatermarksDigest: digest(`high-watermarks:${target}`),
          mutationFenceFingerprint: `fence-v1-${digest(`fence:${target}`)}`,
        },
      },
    );
  });
  return Object.freeze({ closes, drains, installs, inventory });
}

function payload(
  effect: DisasterRecoveryStep,
  operationId: string,
): DisasterRecoveryEffectPayload {
  switch (effect) {
    case "restore_quarantine": {
      const restoredDatabaseDigest = digest("restored-database");
      return {
        backupId: "backup-phase8-1",
        closedGates,
        restoreEffectReceipt: completedEffect(
          operationId,
          "restore_completed",
          "sqlite-restore-receipt-1",
          {
            bindings: {
              backupId: "backup-phase8-1",
              restoredDatabaseDigest,
              restoredHistoryDigest: canonicalHistoryDigest(history),
              streamCut: 2,
            },
            outputDigest: restoredDatabaseDigest,
            relatedSubjectIds: closedGates,
          },
        ),
        restoredDatabaseDigest,
        restoredHistoryDigest: canonicalHistoryDigest(history),
        streamCut: 2,
      };
    }
    case "cluster_authority_rotated":
      return {
        clusterIncarnation: "cluster-after-restore",
        clusterIncarnationVersion: 2,
        namespaceWriterEpoch: 9,
        previousClusterIncarnation: "cluster-before-restore",
        ticketSigningAuthorityId: "ticket-authority-2",
      };
    case "final_authorities_installed": {
      const evidence = authorityEvidence(operationId);
      return {
        authorityCloseEffectReceipts: evidence.closes,
        authorityDrainEffectReceipts: evidence.drains,
        authorityInstallEffectReceipts: evidence.installs,
        authorityInventoryEffectReceipt: evidence.inventory,
      };
    }
    case "external_inventory_reconciled":
      return {
        externalInventoryEffectReceipt: completedEffect(
          operationId,
          "external_inventory_reconciled",
          "external-inventory-1",
          {
            bindings: { inventoryDigest: digest("external-inventory") },
            outputDigest: digest("external-inventory"),
            relatedSubjectIds: executionSubjects,
          },
        ),
      };
    case "projections_rebuilt":
      return {
        outboxReplayComplete: true,
        projectionCheckpointsReset: true,
        streamCut: 2,
      };
    case "erasure_ledger_replayed":
      return {
        erasureReplayEffectReceipt: completedEffect(
          operationId,
          "erasure_replay_completed",
          "erasure-ledger-replay-7",
          { bindings: { erasureHighWatermark: 7 } },
        ),
      };
    case "executions_reconciled":
      return {
        executionReconciliationEffectReceipts: executionSubjects.map(
          (subject) =>
            completedEffect(
              operationId,
              "execution_reconciliation_completed",
              subject,
              { bindings: { proofKind: "signed_absence" } },
            ),
        ),
      };
    case "nodes_reenrolled":
      return {
        credentialGeneration: 2,
        enrolledNodeCount: 3,
        oldCredentialsDisabled: true,
      };
    case "admission_approved":
      return {
        approvalId: "restore-approval-1",
        approvedBy: "operator-1",
        cancellationContinuity: true,
        observationContinuity: true,
      };
  }
}

let sequence = 0;
function receipt(
  operationId: string,
  effect: DisasterRecoveryStep,
  override?: DisasterRecoveryEffectPayload,
) {
  sequence += 1;
  return signDisasterRecoveryEffectReceipt(
    {
      completedAt: 90,
      contractVersion: 1,
      durableSequence: sequence,
      effect,
      nonce: `recovery-receipt-nonce-${String(sequence).padStart(8, "0")}`,
      notAfter: 200,
      operationId,
      payload: override ?? payload(effect, operationId),
      receiptId: `receipt-${effect}-${String(sequence)}`,
      signerKeyId: "recovery-effect-key",
    },
    keys.privateKey,
  );
}

function beginInput(operationId: string, externalAcceptance = 1) {
  return {
    backupManifest: manifest(),
    externalAcceptanceHighWatermark: externalAcceptance,
    externalAuditHighWatermark: 2,
    externalErasureHighWatermark: 7,
    now: 100,
    operationId,
    restoreReceipt: receipt(operationId, "restore_quarantine"),
    restoredHistory: history,
    effectTrust,
  };
}

const remainingSteps = Object.freeze([
  "cluster_authority_rotated",
  "final_authorities_installed",
  "external_inventory_reconciled",
  "projections_rebuilt",
  "erasure_ledger_replayed",
  "executions_reconciled",
  "nodes_reenrolled",
  "admission_approved",
] as const);

describe("Phase 8 signed crash-safe disaster recovery", () => {
  it("reopens durable receipts and admits only after every exact completed effect", () => {
    const path = databasePath();
    let opened = openSqliteDisasterRecoveryStore(path);
    let operation = beginPersistedDisasterRecovery(
      opened.store,
      beginInput("restore-1"),
    );
    expect(() => {
      assertDisasterRecoveryAdmissionOpen(operation);
    }).toThrow("restore_quarantine");
    operation = advancePersistedDisasterRecovery(
      opened.store,
      "restore-1",
      "cluster_authority_rotated",
      receipt("restore-1", "cluster_authority_rotated"),
      effectTrust,
      100,
    );
    opened.close();

    opened = openSqliteDisasterRecoveryStore(path);
    for (const step of remainingSteps.slice(1, -1))
      operation = advancePersistedDisasterRecovery(
        opened.store,
        "restore-1",
        step,
        receipt("restore-1", step),
        effectTrust,
        100,
      );
    opened.close();

    opened = openSqliteDisasterRecoveryStore(path);
    operation = advancePersistedDisasterRecovery(
      opened.store,
      "restore-1",
      "admission_approved",
      receipt("restore-1", "admission_approved"),
      effectTrust,
      100,
    );
    expect(() => {
      assertDisasterRecoveryAdmissionOpen(operation);
    }).not.toThrow();
    expect(operation.receipts).toHaveLength(9);
    expect(operation.recoveredHistoryDigest).toBe(
      operation.backupManifest.canonicalHistoryDigest,
    );
    opened.close();
  });

  it("rejects asserted, tampered, replayed, incomplete, or watermark-gap evidence", () => {
    const opened = openSqliteDisasterRecoveryStore(databasePath());
    let operation = beginPersistedDisasterRecovery(
      opened.store,
      beginInput("restore-bad", 2),
    );
    const signed = receipt("restore-bad", "cluster_authority_rotated");
    expect(() =>
      advancePersistedDisasterRecovery(
        opened.store,
        "restore-bad",
        "cluster_authority_rotated",
        {
          ...signed,
          payload: { ...signed.payload, namespaceWriterEpoch: 99 },
        },
        effectTrust,
        100,
      ),
    ).toThrow("recovery_effect_receipt_invalid");
    operation = advancePersistedDisasterRecovery(
      opened.store,
      "restore-bad",
      "cluster_authority_rotated",
      signed,
      effectTrust,
      100,
    );
    expect(() =>
      advancePersistedDisasterRecovery(
        opened.store,
        "restore-bad",
        "final_authorities_installed",
        receipt("restore-bad", "final_authorities_installed", {
          ...payload("final_authorities_installed", "restore-bad"),
          authorityInstallEffectReceipts: [],
        }),
        effectTrust,
        100,
      ),
    ).toThrow("recovery_authority_evidence_incomplete");
    const tamperedEvidence = payload(
      "final_authorities_installed",
      "restore-bad",
    );
    const inventory =
      tamperedEvidence.authorityInventoryEffectReceipt as DisasterRecoveryCompletedEffectReceipt;
    expect(() =>
      advancePersistedDisasterRecovery(
        opened.store,
        "restore-bad",
        "final_authorities_installed",
        receipt("restore-bad", "final_authorities_installed", {
          ...tamperedEvidence,
          authorityInventoryEffectReceipt: {
            ...inventory,
            signatureBase64Url: "tampered-signature",
          },
        }),
        effectTrust,
        100,
      ),
    ).toThrow("recovery_authority_evidence_incomplete");
    for (const step of remainingSteps.slice(1, -1))
      operation = advancePersistedDisasterRecovery(
        opened.store,
        "restore-bad",
        step,
        receipt("restore-bad", step),
        effectTrust,
        100,
      );
    expect(() =>
      advancePersistedDisasterRecovery(
        opened.store,
        "restore-bad",
        "admission_approved",
        receipt("restore-bad", "admission_approved"),
        effectTrust,
        100,
      ),
    ).toThrow("recovered_external_watermark_gap");
    expect(operation.step).toBe("nodes_reenrolled");
    opened.close();
  });
});
