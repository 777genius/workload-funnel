import { createHash, type KeyObject } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import {
  artifactStageReceiptBinding,
  verifyPrivilegedSealReceipt,
  type ArtifactStageCommand,
  type ArtifactStageReceipt,
  type ArtifactStageWriter,
  type ScopedUploadIdentity,
} from "@workload-funnel/node-execution/result-staging-reporting";
import type {
  ArtifactMutationAuthority,
  ArtifactMutationAuthorityReceipt,
  ResultEntry,
} from "@workload-funnel/workload-control/result-management";

export interface ObjectStagePutReceipt {
  readonly key: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly created: boolean;
}

export interface ScopedCreateOnlyObjectClient {
  readonly scope: ScopedUploadIdentity;
  readonly capabilities: Readonly<{
    createOnly: boolean;
    finalMutationFencing: boolean;
    scopedCredentials: boolean;
    serverChecksum: boolean;
  }>;
  putIfAbsent(
    input: Readonly<{
      key: string;
      bytes: Uint8Array;
      checksum: string;
      authority: ArtifactMutationAuthorityReceipt;
      reauthorize(now: number): ArtifactMutationAuthorityReceipt;
    }>,
  ): Promise<ObjectStagePutReceipt>;
}

export interface SealedObjectReader {
  read(sealId: string, path: string): Promise<Uint8Array>;
}

export interface ObjectStageUploadConfig {
  readonly authority: ArtifactMutationAuthority;
  clientFor(identity: ScopedUploadIdentity): ScopedCreateOnlyObjectClient;
  readonly sealedReader: SealedObjectReader;
  readonly providerId: string;
  readonly nowMs?: () => number;
  readonly trustedSealReceiptKeys: ReadonlyMap<string, KeyObject>;
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

export function objectArtifactKey(identity: string, path: string): string {
  if (
    identity.startsWith("/") ||
    identity.endsWith("/") ||
    identity.includes("\\") ||
    identity.includes("\u0000") ||
    identity !== identity.normalize("NFC") ||
    identity
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error("unsafe_object_staging_identity");
  return `${identity}/${safePath(path)
    .map((segment) => Buffer.from(segment).toString("base64url"))
    .join("/")}`;
}

export function objectArtifactLocation(
  providerId: string,
  key: string,
): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(providerId))
    throw new Error("unsafe_object_provider_id");
  return `object+wf://${providerId}/${Buffer.from(key).toString("base64url")}`;
}

export function objectArtifactKeyFromLocation(
  providerId: string,
  location: string,
): string {
  const prefix = `object+wf://${providerId}/`;
  if (!location.startsWith(prefix))
    throw new Error("object_artifact_location_mismatch");
  const encoded = location.slice(prefix.length);
  const key = Buffer.from(encoded, "base64url").toString("utf8");
  if (
    encoded === "" ||
    Buffer.from(key).toString("base64url") !== encoded ||
    key.includes("\u0000") ||
    key.includes("\\") ||
    key !== key.normalize("NFC") ||
    key
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  )
    throw new Error("object_artifact_location_invalid");
  return key;
}

export function createProvider(
  config: ObjectStageUploadConfig,
): ArtifactStageWriter {
  const nowMs = config.nowMs ?? Date.now;
  return Object.freeze({
    capability: "create_only_scoped_stage",
    providerId: config.providerId,
    async stage(command: ArtifactStageCommand): Promise<ArtifactStageReceipt> {
      assertFence(command.mutationFence, command);
      if (command.privilegedSealReceipt === undefined)
        throw new Error("privileged_seal_receipt_missing");
      verifyPrivilegedSealReceipt(
        command.privilegedSealReceipt,
        command,
        config.trustedSealReceiptKeys,
        nowMs(),
      );
      config.authority.authorize(command.mutationFence, nowMs());
      const client = config.clientFor(command.uploadIdentity);
      if (
        JSON.stringify(client.scope) !== JSON.stringify(command.uploadIdentity)
      )
        throw new Error("object_upload_scope_mismatch");
      if (
        !client.capabilities.createOnly ||
        !client.capabilities.finalMutationFencing ||
        !client.capabilities.scopedCredentials ||
        !client.capabilities.serverChecksum
      )
        throw new Error("object_store_production_capability_missing");
      const immutableStagingIdentity = `${command.uploadIdentity.prefix}${Buffer.from(fingerprintMutationFence(command.mutationFence)).toString("base64url")}/${command.manifestDigest}`;
      const entries: ResultEntry[] = [];
      for (const entry of [...command.entries].sort((left, right) =>
        left.path.localeCompare(right.path),
      )) {
        const key = objectArtifactKey(immutableStagingIdentity, entry.path);
        if (!key.startsWith(command.uploadIdentity.prefix))
          throw new Error("object_upload_scope_escape");
        const bytes = await config.sealedReader.read(
          command.sealId,
          entry.path,
        );
        const checksum = createHash("sha256").update(bytes).digest("hex");
        if (checksum !== entry.digest || bytes.byteLength !== entry.sizeBytes)
          throw new Error("sealed_object_digest_mismatch");
        const authority = config.authority.authorize(
          command.mutationFence,
          nowMs(),
        );
        const put = await client.putIfAbsent({
          authority,
          bytes,
          checksum,
          key,
          reauthorize: (at) =>
            config.authority.authorize(command.mutationFence, at),
        });
        if (
          put.key !== key ||
          put.checksum !== checksum ||
          put.sizeBytes !== bytes.byteLength
        )
          throw new Error("object_store_put_receipt_mismatch");
        entries.push(
          Object.freeze({
            checksum,
            location: objectArtifactLocation(config.providerId, key),
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
        providerId: config.providerId,
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

export {
  AzureBlobCreateOnlyError,
  createAzureBlobPrivateFixtureScopedCreateOnlyClient,
  createAzureBlobScopedCreateOnlyClient,
  type AzureBlobCreateCredentialProvider,
  type AzureBlobCreateOnlyClientConfig,
  type AzureBlobCreateOnlyVerifier,
  type AzureBlobPrivateFixtureClientConfig,
  type AzureBlobScopedCredential,
  type AzureBlobSdkPort,
} from "./azure-blob-create-only-client.js";

export {
  createSqliteArtifactMutationAuthorityStore,
  openSqliteArtifactMutationAuthorityStore,
  type OpenSqliteArtifactMutationAuthorityStore,
} from "./sqlite-artifact-mutation-authority-store.js";
