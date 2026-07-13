import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactDeleteCommand,
  ArtifactDeleteReceipt,
  ArtifactProvider,
} from "@workload-funnel/workload-control/result-management";

export interface ObjectRetentionClient {
  deletePrefixOnce(
    command: ObjectRetentionMutation,
  ): Promise<ObjectDeleteProviderReceipt>;
  reconcilePrefix(
    command: ObjectRetentionMutation,
  ): Promise<ObjectDeleteReconciliationProviderReceipt>;
}

export interface ObjectRetentionMutation {
  readonly identity: string;
  readonly mutationFence: MutationFence;
  readonly operationId: string;
  readonly resultManifestId: string;
}

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

function mutationFor(command: ArtifactDeleteCommand): ObjectRetentionMutation {
  return Object.freeze({
    identity: command.immutableStagingIdentity,
    mutationFence: command.mutationFence,
    operationId: command.operationId,
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

function assertStagingIdentity(command: ArtifactDeleteCommand): void {
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
}

export function createProvider(
  config: ObjectRetentionDeleteConfig,
): ArtifactProvider {
  const nowMs = config.nowMs ?? Date.now;
  return Object.freeze({
    capabilities: Object.freeze(["retention_delete"] as const),
    async delete(
      command: ArtifactDeleteCommand,
    ): Promise<ArtifactDeleteReceipt> {
      assertFence(command.mutationFence, command.resultManifestId);
      assertStagingIdentity(command);
      const receipt = await config.client.deletePrefixOnce(
        mutationFor(command),
      );
      assertProviderReceipt(config, command, receipt);
      return receipt;
    },
    async reconcileDelete(command: ArtifactDeleteCommand) {
      assertFence(command.mutationFence, command.resultManifestId);
      assertStagingIdentity(command);
      const receipt = await config.client.reconcilePrefix(mutationFor(command));
      assertProviderReceipt(config, command, receipt);
      return Object.freeze({ ...receipt, reconciledAtMs: nowMs() });
    },
    providerId: config.providerId,
  });
}
