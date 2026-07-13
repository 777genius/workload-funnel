import { createHash } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  artifactStageReceiptBinding,
  type ArtifactStageCommand,
  type ArtifactStageReceipt,
  type ArtifactStageWriter,
  type ScopedUploadIdentity,
} from "@workload-funnel/node-execution/result-staging-reporting";
import type { ResultEntry } from "@workload-funnel/workload-control/result-management";

export interface ObjectStagePutReceipt {
  readonly key: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly created: boolean;
}

export interface ScopedCreateOnlyObjectClient {
  readonly scope: ScopedUploadIdentity;
  putIfAbsent(
    input: Readonly<{
      key: string;
      bytes: Uint8Array;
      checksum: string;
    }>,
  ): Promise<ObjectStagePutReceipt>;
}

export interface SealedObjectReader {
  read(sealId: string, path: string): Promise<Uint8Array>;
}

export interface ObjectStageUploadConfig {
  clientFor(identity: ScopedUploadIdentity): ScopedCreateOnlyObjectClient;
  readonly sealedReader: SealedObjectReader;
  readonly providerId: string;
}

function assertFence(
  fence: MutationFence,
  command: ArtifactStageCommand,
): void {
  validateMutationFence(fence);
  const uploadIdentity = command.uploadIdentity as unknown as Readonly<{
    allocationId?: unknown;
    prefix?: unknown;
    permissions?: unknown;
    canList?: unknown;
    canRead?: unknown;
    canOverwrite?: unknown;
    canDelete?: unknown;
  }>;
  if (
    fence.desiredEffect !== "artifact_stage" ||
    fence.requiredGate !== "result_finalize" ||
    fence.allocationId !== command.allocationId ||
    fence.attemptId !== command.attemptId ||
    fence.executionGeneration !== command.executionGeneration ||
    fence.effectScopeKey !== `artifact-stage:${command.executionId}` ||
    uploadIdentity.allocationId !== command.allocationId ||
    uploadIdentity.prefix !==
      `${command.allocationId}/${command.executionGeneration}/` ||
    !Array.isArray(uploadIdentity.permissions) ||
    uploadIdentity.permissions.length !== 1 ||
    uploadIdentity.permissions[0] !== "create" ||
    uploadIdentity.canList !== false ||
    uploadIdentity.canRead !== false ||
    uploadIdentity.canOverwrite !== false ||
    uploadIdentity.canDelete !== false
  )
    throw new Error("object_stage_fence_mismatch");
}

function safePath(path: string): readonly string[] {
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path !== path.normalize("NFC") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new Error("unsafe_object_artifact_path");
  return segments;
}

export function createProvider(
  config: ObjectStageUploadConfig,
): ArtifactStageWriter {
  return Object.freeze({
    capability: "create_only_scoped_stage",
    async stage(command: ArtifactStageCommand): Promise<ArtifactStageReceipt> {
      assertFence(command.mutationFence, command);
      const client = config.clientFor(command.uploadIdentity);
      if (
        JSON.stringify(client.scope) !== JSON.stringify(command.uploadIdentity)
      )
        throw new Error("object_upload_scope_mismatch");
      const immutableStagingIdentity = `${command.uploadIdentity.prefix}${Buffer.from(fingerprintMutationFence(command.mutationFence)).toString("base64url")}/${command.manifestDigest}`;
      const entries: ResultEntry[] = [];
      for (const entry of [...command.entries].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        const segments = safePath(entry.path);
        const key = `${immutableStagingIdentity}/${segments.map((segment) => Buffer.from(segment).toString("base64url")).join("/")}`;
        if (!key.startsWith(command.uploadIdentity.prefix))
          throw new Error("object_upload_scope_escape");
        const bytes = await config.sealedReader.read(
          command.sealId,
          entry.path,
        );
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== entry.digest || bytes.byteLength !== entry.sizeBytes)
          throw new Error("sealed_object_digest_mismatch");
        const put = await client.putIfAbsent({ bytes, checksum, key });
        if (
          put.key !== key ||
          put.checksum !== checksum ||
          put.sizeBytes !== bytes.byteLength
        )
          throw new Error("object_store_put_receipt_mismatch");
        entries.push(
          Object.freeze({
            checksum,
            location: `object+wf://${config.providerId}/${Buffer.from(key).toString("base64url")}`,
            path: entry.path,
            sizeBytes: bytes.byteLength,
          }),
        );
      }
      const receiptFields = {
        entries: Object.freeze(entries),
        immutableStagingIdentity,
        manifestDigest: command.manifestDigest,
        mutationFenceFingerprint: fingerprintMutationFence(
          command.mutationFence,
        ),
        operationId: command.operationId,
      };
      return Object.freeze({
        ...receiptFields,
        bindingDigest: artifactStageReceiptBinding(receiptFields),
        mutationFence: command.mutationFence,
        state: "staged",
      });
    },
  });
}
