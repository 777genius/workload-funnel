import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactDeleteCommand,
  ArtifactDeleteReceipt,
  ArtifactMutationAuthority,
  ArtifactMutationAuthorityReceipt,
  ArtifactProvider,
  ResultEntry,
} from "@workload-funnel/workload-control/result-management";

export interface ObjectRetentionClient {
  readonly capabilities: Readonly<{
    exactResourceDeleteOnly: boolean;
    finalMutationFencing: boolean;
    retentionCredential: boolean;
  }>;
  deleteExactSetOnce(
    command: ObjectRetentionMutation,
  ): Promise<ObjectDeleteProviderReceipt>;
  reconcileExactSet(
    command: ObjectRetentionMutation,
  ): Promise<ObjectDeleteReconciliationProviderReceipt>;
}

export interface ObjectRetentionMutation {
  readonly authority: ArtifactMutationAuthorityReceipt;
  readonly expectedEntries: readonly ResultEntry[];
  readonly identity: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
  readonly reauthorize: (now: number) => ArtifactMutationAuthorityReceipt;
  readonly resultManifestId: string;
}

type BoundArtifactDeleteCommand = ArtifactDeleteCommand &
  Readonly<{ expectedEntries: readonly ResultEntry[] }>;

export interface ObjectDeleteProviderReceipt {
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly providerId: string;
  readonly providerReceiptId: string;
  readonly resultManifestId: string;
  readonly status: "deleted" | "unknown";
}

export interface ObjectDeleteReconciliationProviderReceipt {
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly operationId: string;
  readonly providerId: string;
  readonly providerReceiptId: string;
  readonly resultManifestId: string;
  readonly status: "still_present" | "verified_absent";
}

function mutationFor(
  command: BoundArtifactDeleteCommand,
  authority: ArtifactMutationAuthorityReceipt,
  reauthorize: (now: number) => ArtifactMutationAuthorityReceipt,
): ObjectRetentionMutation {
  return Object.freeze({
    authority,
    expectedEntries: Object.freeze([...command.expectedEntries]),
    identity: command.immutableStagingIdentity,
    mutationFence: command.mutationFence,
    operationId: command.operationId,
    reauthorize,
    resultManifestId: command.resultManifestId,
  });
}

function assertProviderReceipt(
  config: ObjectRetentionDeleteConfig,
  command: ArtifactDeleteCommand,
  receipt:
    | ObjectDeleteProviderReceipt
    | ObjectDeleteReconciliationProviderReceipt,
): void {
  const fingerprint = fingerprintMutationFence(command.mutationFence);
  if (
    receipt.operationId !== command.operationId ||
    receipt.resultManifestId !== command.resultManifestId ||
    receipt.providerId !== config.providerId ||
    receipt.providerReceiptId.length === 0 ||
    receipt.mutationFenceFingerprint !== fingerprint ||
    fingerprintMutationFence(receipt.mutationFence) !== fingerprint
  )
    throw new Error("object_delete_provider_receipt_mismatch");
}

export interface ObjectRetentionDeleteConfig {
  readonly authority: ArtifactMutationAuthority;
  readonly client: ObjectRetentionClient;
  readonly providerId: string;
  readonly nowMs?: () => number;
}

function assertFence(fence: MutationFence, manifestId: string): void {
  validateMutationFence(fence);
  if (
    fence.desiredEffect !== "artifact_delete" ||
    fence.requiredGate !== "result_retention" ||
    fence.effectScopeKey !== `artifact-delete:${manifestId}` ||
    fingerprintMutationFence(fence).length !== 73
  )
    throw new Error("object_delete_fence_mismatch");
}

function assertStagingIdentity(
  command: ArtifactDeleteCommand,
): asserts command is BoundArtifactDeleteCommand {
  const stagingFence = command.stagingMutationFence;
  validateMutationFence(stagingFence);
  if (
    command.stagingMutationFenceFingerprint !==
      fingerprintMutationFence(stagingFence) ||
    stagingFence.desiredEffect !== "artifact_stage" ||
    stagingFence.allocationId !== command.mutationFence.allocationId ||
    stagingFence.attemptId !== command.mutationFence.attemptId ||
    stagingFence.executionGeneration !==
      command.mutationFence.executionGeneration ||
    command.immutableStagingIdentity !==
      `${stagingFence.allocationId ?? ""}/${stagingFence.executionGeneration}/${Buffer.from(command.stagingMutationFenceFingerprint).toString("base64url")}/${command.immutableStagingIdentity.split("/").at(-1) ?? ""}`
  )
    throw new Error("object_delete_scope_mismatch");
  const expectedEntries = command.expectedEntries;
  if (
    expectedEntries?.length !== command.entryDigests.length ||
    expectedEntries.some(
      (entry, index) => entry.checksum !== command.entryDigests[index],
    )
  )
    throw new Error("object_delete_entry_binding_mismatch");
}

export function createProvider(
  config: ObjectRetentionDeleteConfig,
): ArtifactProvider {
  const nowMs = config.nowMs ?? Date.now;
  if (
    !config.client.capabilities.finalMutationFencing ||
    !config.client.capabilities.exactResourceDeleteOnly ||
    !config.client.capabilities.retentionCredential
  )
    throw new Error("object_store_retention_capability_missing");
  return Object.freeze({
    capabilities: Object.freeze(["retention_delete"] as const),
    async delete(
      command: ArtifactDeleteCommand,
    ): Promise<ArtifactDeleteReceipt> {
      assertFence(command.mutationFence, command.resultManifestId);
      assertStagingIdentity(command);
      const reauthorize = (at: number) =>
        config.authority.authorize(command.mutationFence, at);
      const authority = reauthorize(nowMs());
      const receipt = await config.client.deleteExactSetOnce(
        mutationFor(command, authority, reauthorize),
      );
      assertProviderReceipt(config, command, receipt);
      return receipt;
    },
    async reconcileDelete(command: ArtifactDeleteCommand) {
      assertFence(command.mutationFence, command.resultManifestId);
      assertStagingIdentity(command);
      const reauthorize = (at: number) =>
        config.authority.authorize(command.mutationFence, at);
      const receipt = await config.client.reconcileExactSet(
        mutationFor(command, reauthorize(nowMs()), reauthorize),
      );
      assertProviderReceipt(config, command, receipt);
      return Object.freeze({ ...receipt, reconciledAtMs: nowMs() });
    },
    providerId: config.providerId,
  });
}

export {
  AzureBlobRetentionError,
  createAzureBlobExactRetentionClient,
  createAzureBlobPrivateFixtureExactRetentionClient,
  type AzureBlobExactRetentionClientConfig,
  type AzureBlobPrivateFixtureExactRetentionClientConfig,
  type AzureBlobRetentionCredential,
  type AzureBlobRetentionDeleteCredentialProvider,
  type AzureBlobRetentionReadCredentialProvider,
  type AzureBlobRetentionSdkPort,
} from "./azure-blob-exact-retention-client.js";
