import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import type {
  ArtifactProviderSet,
  ArtifactVerificationReceipt,
  ArtifactDeleteReceipt,
  ArtifactDeleteReconciliationReceipt,
} from "./contracts/artifact-provider.js";
import {
  finalizeResultManifest,
  markArtifactOperationUnknown,
  reconcileArtifactOperation,
  tombstoneResult,
  validatePersistedStagingEvidence,
  type ResultManifest,
  type ResultTombstone,
} from "../domain/result-manifest.js";

export interface FinalizeStagedResultCommand {
  readonly operationId: string;
  readonly manifest: ResultManifest;
  readonly mutationFence: MutationFence;
}

export interface DeleteRetainedResultCommand {
  readonly manifest: ResultManifest;
  readonly mutationFence: MutationFence;
  readonly tombstone: ResultTombstone;
}

export async function verifyAndFinalizeStagedResult(
  providers: ArtifactProviderSet,
  command: FinalizeStagedResultCommand,
): Promise<
  Readonly<{
    manifest: ResultManifest;
    verification: ArtifactVerificationReceipt;
  }>
> {
  const manifest = command.manifest;
  validatePersistedStagingEvidence(manifest);
  if (
    manifest.immutableStagingIdentity === undefined ||
    manifest.artifactProviderId === undefined ||
    manifest.manifestDigest === undefined ||
    manifest.stagingMutationFence === undefined ||
    manifest.stagingMutationFenceFingerprint === undefined
  ) {
    throw new Error("result_manifest_not_staged");
  }
  const provider = providers.select(
    manifest.artifactProviderId,
    "verify_finalized_bytes",
  );
  const verification = await provider.verify?.({
    expectedEntries: manifest.entries,
    immutableStagingIdentity: manifest.immutableStagingIdentity,
    manifestDigest: manifest.manifestDigest,
    mutationFence: command.mutationFence,
    operationId: command.operationId,
    resultManifestId: manifest.resultManifestId,
    stagingMutationFence: manifest.stagingMutationFence,
    stagingMutationFenceFingerprint: manifest.stagingMutationFenceFingerprint,
  });
  if (verification === undefined)
    throw new Error("artifact_verifier_missing_operation");
  return Object.freeze({
    manifest: finalizeResultManifest(manifest, verification),
    verification,
  });
}

export async function deleteAndTombstoneResult(
  providers: ArtifactProviderSet,
  command: DeleteRetainedResultCommand,
): Promise<
  Readonly<{ manifest: ResultManifest; deletion: ArtifactDeleteReceipt }>
> {
  const manifest = command.manifest;
  validatePersistedStagingEvidence(manifest);
  const operation = manifest.artifactOperation;
  if (
    operation?.kind !== "delete" ||
    manifest.retentionState !== "deleting" ||
    manifest.immutableStagingIdentity === undefined ||
    manifest.artifactProviderId === undefined ||
    manifest.stagingMutationFence === undefined ||
    manifest.stagingMutationFenceFingerprint === undefined ||
    !["prepared", "retryable"].includes(operation.state)
  )
    throw new Error("result_delete_not_prepared");
  const provider = providers.select(
    manifest.artifactProviderId,
    "retention_delete",
  );
  const deletion = await provider.delete?.({
    entryDigests: manifest.entries.map((entry) => entry.checksum),
    immutableStagingIdentity: manifest.immutableStagingIdentity,
    mutationFence: command.mutationFence,
    operationId: operation.operationId,
    resultManifestId: manifest.resultManifestId,
    stagingMutationFence: manifest.stagingMutationFence,
    stagingMutationFenceFingerprint: manifest.stagingMutationFenceFingerprint,
  });
  if (deletion === undefined)
    throw new Error("artifact_delete_missing_operation");
  assertDeleteReceipt(command, deletion, provider.providerId);
  if (deletion.status === "unknown") {
    return Object.freeze({
      deletion,
      manifest: markArtifactOperationUnknown(manifest),
    });
  }
  return Object.freeze({
    deletion,
    manifest: reconcileArtifactOperation(manifest, "applied"),
  });
}

export async function reconcileDeletionAndTombstoneResult(
  providers: ArtifactProviderSet,
  command: DeleteRetainedResultCommand,
): Promise<
  Readonly<{
    manifest: ResultManifest;
    reconciliation: ArtifactDeleteReconciliationReceipt;
  }>
> {
  const manifest = command.manifest;
  validatePersistedStagingEvidence(manifest);
  const operation = manifest.artifactOperation;
  if (
    operation?.kind !== "delete" ||
    !["unknown", "applied"].includes(operation.state) ||
    manifest.retentionState !== "deleting" ||
    manifest.immutableStagingIdentity === undefined ||
    manifest.artifactProviderId === undefined ||
    manifest.stagingMutationFence === undefined ||
    manifest.stagingMutationFenceFingerprint === undefined
  )
    throw new Error("result_delete_reconciliation_not_prepared");
  const provider = providers.select(
    manifest.artifactProviderId,
    "retention_delete",
  );
  const reconciliation = await provider.reconcileDelete?.({
    entryDigests: manifest.entries.map((entry) => entry.checksum),
    immutableStagingIdentity: manifest.immutableStagingIdentity,
    mutationFence: command.mutationFence,
    operationId: operation.operationId,
    resultManifestId: manifest.resultManifestId,
    stagingMutationFence: manifest.stagingMutationFence,
    stagingMutationFenceFingerprint: manifest.stagingMutationFenceFingerprint,
  });
  if (reconciliation === undefined)
    throw new Error("artifact_delete_reconciliation_missing_operation");
  assertDeleteReceipt(command, reconciliation, provider.providerId);
  const reconciled = reconcileArtifactOperation(
    manifest,
    reconciliation.status,
  );
  return Object.freeze({
    manifest:
      reconciliation.status === "verified_absent"
        ? tombstoneResult(reconciled, command.tombstone)
        : reconciled,
    reconciliation,
  });
}

function assertDeleteReceipt(
  command: DeleteRetainedResultCommand,
  receipt: ArtifactDeleteReceipt | ArtifactDeleteReconciliationReceipt,
  expectedProviderId: string,
): void {
  if (
    receipt.operationId !== command.manifest.artifactOperation?.operationId ||
    receipt.resultManifestId !== command.manifest.resultManifestId ||
    receipt.providerId !== expectedProviderId ||
    receipt.providerReceiptId.length === 0 ||
    receipt.mutationFenceFingerprint !==
      fingerprintMutationFence(command.mutationFence) ||
    fingerprintMutationFence(receipt.mutationFence) !==
      receipt.mutationFenceFingerprint
  )
    throw new Error("artifact_delete_receipt_fence_mismatch");
}
