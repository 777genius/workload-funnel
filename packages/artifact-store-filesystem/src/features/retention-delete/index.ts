import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactDeleteCommand,
  ArtifactDeleteReceipt,
  ArtifactMutationAuthority,
  ArtifactProvider,
} from "@workload-funnel/workload-control/result-management";

export interface FilesystemRetentionDeleteConfig {
  readonly authority: ArtifactMutationAuthority;
  readonly root: string;
  readonly nowMs?: () => number;
}

function identityDirectory(root: string, identity: string): string {
  return join(root, createHash("sha256").update(identity).digest("hex"));
}

function assertDeleteFence(
  fence: MutationFence,
  resultManifestId: string,
  immutableStagingIdentity: string,
  stagingFence: MutationFence,
  stagingFenceFingerprint: string,
): void {
  validateMutationFence(fence);
  validateMutationFence(stagingFence);
  if (
    fence.desiredEffect !== "artifact_delete" ||
    fence.requiredGate !== "result_retention" ||
    fence.effectScopeKey !== `artifact-delete:${resultManifestId}` ||
    stagingFenceFingerprint !== fingerprintMutationFence(stagingFence) ||
    stagingFence.desiredEffect !== "artifact_stage" ||
    stagingFence.allocationId !== fence.allocationId ||
    stagingFence.attemptId !== fence.attemptId ||
    stagingFence.executionGeneration !== fence.executionGeneration ||
    !immutableStagingIdentity.startsWith(
      `local-v2:${Buffer.from(stagingFence.allocationId ?? "").toString("base64url")}:${Buffer.from(stagingFence.executionGeneration).toString("base64url")}:${Buffer.from(stagingFenceFingerprint).toString("base64url")}:`,
    ) ||
    fingerprintMutationFence(fence).length !== 73
  )
    throw new Error("artifact_delete_fence_mismatch");
}

export function createProvider(
  config: FilesystemRetentionDeleteConfig,
): ArtifactProvider {
  const root = resolve(config.root);
  if (!isAbsolute(root)) throw new Error("artifact_root_must_be_absolute");
  const nowMs = config.nowMs ?? Date.now;
  return Object.freeze({
    capabilities: Object.freeze(["retention_delete"] as const),
    async delete(
      command: ArtifactDeleteCommand,
    ): Promise<ArtifactDeleteReceipt> {
      assertDeleteFence(
        command.mutationFence,
        command.resultManifestId,
        command.immutableStagingIdentity,
        command.stagingMutationFence,
        command.stagingMutationFenceFingerprint,
      );
      const target = identityDirectory(root, command.immutableStagingIdentity);
      const metadata = await lstat(target).catch(() => undefined);
      if (metadata?.isSymbolicLink())
        throw new Error("unsafe_artifact_delete_target");
      if (metadata !== undefined && !metadata.isDirectory())
        throw new Error("unsafe_artifact_delete_target");
      if (metadata !== undefined) {
        config.authority.authorize(command.mutationFence, nowMs());
        try {
          await rm(target, { recursive: true, force: false });
        } catch {
          return Object.freeze({
            mutationFence: command.mutationFence,
            mutationFenceFingerprint: fingerprintMutationFence(
              command.mutationFence,
            ),
            operationId: command.operationId,
            providerId: "local-filesystem",
            providerReceiptId: `local-filesystem:${command.operationId}:delete`,
            resultManifestId: command.resultManifestId,
            status: "unknown",
          });
        }
      }
      const remains = await lstat(target).catch(() => undefined);
      if (remains !== undefined)
        return Object.freeze({
          mutationFence: command.mutationFence,
          mutationFenceFingerprint: fingerprintMutationFence(
            command.mutationFence,
          ),
          operationId: command.operationId,
          providerId: "local-filesystem",
          providerReceiptId: `local-filesystem:${command.operationId}:delete`,
          resultManifestId: command.resultManifestId,
          status: "unknown",
        });
      return Object.freeze({
        mutationFence: command.mutationFence,
        mutationFenceFingerprint: fingerprintMutationFence(
          command.mutationFence,
        ),
        operationId: command.operationId,
        providerId: "local-filesystem",
        providerReceiptId: `local-filesystem:${command.operationId}:delete`,
        resultManifestId: command.resultManifestId,
        status: "deleted",
      });
    },
    async reconcileDelete(command: ArtifactDeleteCommand) {
      assertDeleteFence(
        command.mutationFence,
        command.resultManifestId,
        command.immutableStagingIdentity,
        command.stagingMutationFence,
        command.stagingMutationFenceFingerprint,
      );
      const target = identityDirectory(root, command.immutableStagingIdentity);
      const remains = await lstat(target).catch(() => undefined);
      if (
        remains?.isSymbolicLink() ||
        (remains !== undefined && !remains.isDirectory())
      )
        throw new Error("unsafe_artifact_delete_target");
      return Object.freeze({
        mutationFence: command.mutationFence,
        mutationFenceFingerprint: fingerprintMutationFence(
          command.mutationFence,
        ),
        operationId: command.operationId,
        providerId: "local-filesystem",
        providerReceiptId: `local-filesystem:${command.operationId}:reconcile`,
        reconciledAtMs: nowMs(),
        resultManifestId: command.resultManifestId,
        status: remains === undefined ? "verified_absent" : "still_present",
      });
    },
    providerId: "local-filesystem",
  });
}
