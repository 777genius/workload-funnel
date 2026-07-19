import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactProvider,
  ArtifactVerificationCommand,
  ArtifactVerificationReceipt,
} from "@workload-funnel/workload-control/result-management";

export interface ObjectMetadataReader {
  head(
    key: string,
  ): Promise<Readonly<{ checksum: string; sizeBytes: number }> | undefined>;
}

export interface ObjectVerifyFinalizeConfig {
  readonly metadata: ObjectMetadataReader;
  readonly providerId: string;
  readonly nowMs?: () => number;
}

function objectArtifactKey(identity: string, path: string): string {
  const identitySegments = identity.split("/");
  const pathSegments = path.split("/");
  if (
    identity.startsWith("/") ||
    identity.endsWith("/") ||
    identity.includes("\\") ||
    identity.includes("\u0000") ||
    identity !== identity.normalize("NFC") ||
    identitySegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\u0000") ||
    path !== path.normalize("NFC") ||
    pathSegments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  )
    throw new Error("unsafe_object_artifact_path");
  return `${identity}/${pathSegments
    .map((segment) => Buffer.from(segment).toString("base64url"))
    .join("/")}`;
}

function assertFence(fence: MutationFence, manifestId: string): void {
  validateMutationFence(fence);
  if (
    fence.desiredEffect !== "artifact_finalize" ||
    fence.requiredGate !== "result_finalize" ||
    fence.effectScopeKey !== `result-finalize:${manifestId}` ||
    fingerprintMutationFence(fence).length !== 73
  )
    throw new Error("object_verification_fence_mismatch");
}

export function createProvider(
  config: ObjectVerifyFinalizeConfig,
): ArtifactProvider {
  const nowMs = config.nowMs ?? Date.now;
  return Object.freeze({
    capabilities: Object.freeze(["verify_finalized_bytes"] as const),
    providerId: config.providerId,
    async verify(
      command: ArtifactVerificationCommand,
    ): Promise<ArtifactVerificationReceipt> {
      assertFence(command.mutationFence, command.resultManifestId);
      if (
        fingerprintMutationFence(command.stagingMutationFence) !==
          command.stagingMutationFenceFingerprint ||
        command.stagingMutationFence.desiredEffect !== "artifact_stage" ||
        command.stagingMutationFence.allocationId !==
          command.mutationFence.allocationId ||
        command.stagingMutationFence.attemptId !==
          command.mutationFence.attemptId ||
        command.stagingMutationFence.executionGeneration !==
          command.mutationFence.executionGeneration ||
        command.immutableStagingIdentity !==
          `${command.mutationFence.allocationId ?? ""}/${command.mutationFence.executionGeneration}/${Buffer.from(command.stagingMutationFenceFingerprint).toString("base64url")}/${command.manifestDigest}`
      )
        throw new Error("object_verification_scope_mismatch");
      for (const entry of command.expectedEntries) {
        const metadata = await config.metadata.head(
          objectArtifactKey(command.immutableStagingIdentity, entry.path),
        );
        if (
          metadata?.checksum !== entry.checksum ||
          metadata.sizeBytes !== entry.sizeBytes
        )
          throw new Error("object_server_checksum_mismatch");
      }
      return Object.freeze({
        immutableStagingIdentity: command.immutableStagingIdentity,
        manifestDigest: command.manifestDigest,
        operationId: command.operationId,
        providerId: config.providerId,
        resultManifestId: command.resultManifestId,
        status: "verified",
        verifiedAtMs: nowMs(),
        verifiedEntries: Object.freeze([...command.expectedEntries]),
      });
    },
  });
}

export {
  AzureBlobMetadataReaderError,
  createAzureBlobExactCreateOutcomeVerifier,
  createAzureBlobExactMetadataReader,
  createAzureBlobPrivateFixtureExactCreateOutcomeVerifier,
  createAzureBlobPrivateFixtureExactMetadataReader,
  type AzureBlobExactCreateOutcomeVerifier,
  type AzureBlobMetadataReaderConfig,
  type AzureBlobMetadataSdkPort,
  type AzureBlobPrivateFixtureMetadataReaderConfig,
  type AzureBlobReadCredential,
  type AzureBlobReadCredentialProvider,
} from "./azure-blob-metadata-reader.js";
