import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { URL } from "node:url";

import {
  BlobSASPermissions,
  BlobServiceClient,
  ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import {
  createAzureBlobPrivateFixtureScopedCreateOnlyClient,
  objectArtifactKey,
  objectArtifactLocation,
} from "@workload-funnel/artifact-store-object/stage-upload";
import { createAzureBlobPrivateFixtureExactCreateOutcomeVerifier } from "@workload-funnel/artifact-store-object/verify-finalize";
import { createAzureBlobPrivateFixtureExactRetentionClient } from "@workload-funnel/artifact-store-object/retention-delete";
import { fingerprintMutationFence } from "@workload-funnel/kernel";

import {
  AZURITE_API_VERSION,
  azuriteBlobClient,
  azuriteBlockBlobClient,
  azuriteMetadataSdk,
  azuritePipeline,
  azuriteRetentionSdk,
  azuriteUploadSdk,
} from "./azure-sdk-fixture-pipeline.mjs";

const ACCOUNT_NAME = "wfaccount";
const PROVIDER_ID = "azure-blob-storage";
const SDK_VERSION = "12.33.0";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sharedKey(accountKey) {
  return new StorageSharedKeyCredential(ACCOUNT_NAME, accountKey);
}

function serviceClient(endpoint, accountKey) {
  return new BlobServiceClient(
    endpoint,
    azuritePipeline(sharedKey(accountKey)),
  );
}

export async function azureBlobFixtureReady({ accountKey, endpoint }) {
  try {
    const iterator = serviceClient(endpoint, accountKey)
      .listContainers()
      .byPage({ maxPageSize: 1 });
    await iterator.next();
    return true;
  } catch {
    return false;
  }
}

function mutationAuthority(allocationId, nowMs, desiredEffect, manifestId) {
  const artifactStage = desiredEffect === "artifact_stage";
  const effectScopeKey = artifactStage
    ? "artifact-stage:azure-object-execution-1"
    : `artifact-delete:${manifestId}`;
  const mutationFence = Object.freeze({
    allocationId,
    attemptId: "azure-object-attempt-1",
    clusterIncarnation: "production-gate-fixture",
    clusterIncarnationVersion: 1,
    desiredEffect,
    effectScopeKey,
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    namespaceId: "production-gate",
    namespaceWriterEpoch: 1,
    notAfter: nowMs + 10 * 60_000,
    notBefore: nowMs - 60_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: artifactStage ? "result_finalize" : "result_retention",
    schemaVersion: 1,
    supersessionKey: effectScopeKey,
  });
  return Object.freeze({
    durableSequence: 1,
    effectScopeKey,
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    operationId: artifactStage
      ? "azure-object-authority-1"
      : "azure-object-delete-authority-1",
    writerIdentity: artifactStage
      ? "production-gate-upload"
      : "production-gate-retention",
  });
}

function scopedIdentity(allocationId, prefix) {
  return Object.freeze({
    allocationId,
    canDelete: false,
    canList: false,
    canOverwrite: false,
    canRead: false,
    permissions: Object.freeze(["create"]),
    prefix,
  });
}

function blobCredential({
  blobName,
  container,
  credential,
  nowMs,
  permissions,
  expiresAtMs = nowMs + 5 * 60_000,
}) {
  const query = generateBlobSASQueryParameters(
    {
      blobName,
      containerName: container.containerName,
      expiresOn: new Date(expiresAtMs),
      permissions: BlobSASPermissions.parse(permissions),
      protocol: SASProtocol.HttpsAndHttp,
      startsOn: new Date(nowMs - 5 * 60_000),
      version: AZURITE_API_VERSION,
    },
    credential,
  ).toString();
  return Object.freeze({
    blobUrl: `${container.getBlobClient(blobName).url}?${query}`,
    expiresAtMs,
  });
}

async function permissionDenied(action) {
  try {
    await action();
    return false;
  } catch (error) {
    return error?.statusCode === 403;
  }
}

async function snapshot(blob) {
  const [properties, bytes] = await Promise.all([
    blob.getProperties(),
    blob.downloadToBuffer(),
  ]);
  return Object.freeze({
    bytes,
    contentMd5: properties.contentMD5,
    metadataSha256: properties.metadata?.["wfsha256"],
  });
}

function exactSnapshot(value, expectedBytes, expectedChecksum, expectedMd5) {
  return (
    Buffer.from(value.bytes).equals(expectedBytes) &&
    Buffer.from(value.contentMd5 ?? []).equals(expectedMd5) &&
    value.metadataSha256 === expectedChecksum
  );
}

function exactOrigin(endpoint) {
  return new URL(endpoint).origin;
}

function fixture(endpoint) {
  return Object.freeze({
    exactOrigin: exactOrigin(endpoint),
    serviceVersion: AZURITE_API_VERSION,
  });
}

function createOutcomeVerifier({ container, credential, endpoint, nowMs }) {
  return createAzureBlobPrivateFixtureExactCreateOutcomeVerifier({
    blobUrlForKey: (key) => container.getBlobClient(key).url,
    credentials: {
      readForKey: (key) =>
        Promise.resolve(
          blobCredential({
            blobName: key,
            container,
            credential,
            nowMs,
            permissions: "r",
          }),
        ),
    },
    fixture: fixture(endpoint),
    nowMs: () => nowMs,
    sdk: azuriteMetadataSdk,
  });
}

function uploadClient({
  container,
  createPermissions = "c",
  credential,
  endpoint,
  expiresAtMs,
  nowMs,
  scope,
}) {
  const verifier = createOutcomeVerifier({
    container,
    credential,
    endpoint,
    nowMs,
  });
  return createAzureBlobPrivateFixtureScopedCreateOnlyClient({
    blobUrlForKey: (key) => container.getBlobClient(key).url,
    credentials: {
      createForKey: (key) =>
        Promise.resolve(
          blobCredential({
            blobName: key,
            container,
            credential,
            expiresAtMs,
            nowMs,
            permissions: createPermissions,
          }),
        ),
    },
    fixture: fixture(endpoint),
    nowMs: () => nowMs,
    scope,
    sdk: azuriteUploadSdk,
    verifier,
  });
}

function retentionClient({ container, credential, endpoint, nowMs }) {
  const issue = (key, permissions) =>
    Promise.resolve(
      blobCredential({
        blobName: key,
        container,
        credential,
        nowMs,
        permissions,
      }),
    );
  return createAzureBlobPrivateFixtureExactRetentionClient({
    blobUrlForKey: (key) => container.getBlobClient(key).url,
    deleteCredentials: { deleteForKey: (key) => issue(key, "d") },
    fixture: fixture(endpoint),
    nowMs: () => nowMs,
    providerId: PROVIDER_ID,
    readCredentials: { readForKey: (key) => issue(key, "r") },
    sdk: azuriteRetentionSdk,
  });
}

async function adapterRejectionCode(client, input) {
  try {
    await client.putIfAbsent(input);
    return undefined;
  } catch (error) {
    return error?.code;
  }
}

export async function runAzureObjectAdapterProbe({
  accountKey,
  endpoint,
  fixtureImage,
  restart,
  runId,
}) {
  if (
    typeof accountKey !== "string" ||
    accountKey.length < 32 ||
    typeof endpoint !== "string" ||
    !endpoint.startsWith("http://") ||
    typeof fixtureImage !== "string" ||
    typeof restart !== "function" ||
    typeof runId !== "string"
  )
    throw new Error("azure_object_probe_configuration_invalid");

  const service = serviceClient(endpoint, accountKey);
  const suffix = runId.slice("wf-production-gate-".length);
  const containerName = `wf${suffix}`;
  const foreignContainerName = `wx${suffix}`;
  await service.createContainer(containerName);
  await service.createContainer(foreignContainerName);
  const container = service.getContainerClient(containerName);
  const foreignContainer = service.getContainerClient(foreignContainerName);
  const credential = sharedKey(accountKey);
  const allocationId = "azure-object-allocation-1";
  const prefix = `${allocationId}/generation-1/`;
  const nowMs = Date.now();
  const stageAuthority = mutationAuthority(
    allocationId,
    nowMs,
    "artifact_stage",
    "manifest-1",
  );
  const identity = `${prefix}${Buffer.from(
    stageAuthority.mutationFenceFingerprint,
  ).toString("base64url")}/${"a".repeat(64)}`;
  const key = objectArtifactKey(identity, "artifact.bin");
  const retentionKey = objectArtifactKey(identity, "retained.bin");
  const forgedKey = objectArtifactKey(identity, "forged.bin");
  const otherKey = objectArtifactKey(identity, "foreign.bin");
  const foreignKey = "foreign-allocation/generation-1/artifact.bin";
  const bytes = Buffer.from(
    "workload-funnel-azure-create-only-fixture",
    "utf8",
  );
  const replacement = Buffer.from(
    "workload-funnel-azure-overwrite-attempt",
    "utf8",
  );
  const checksum = sha256(bytes);
  const contentMd5 = createHash("md5").update(bytes).digest();
  const scope = scopedIdentity(allocationId, prefix);
  const input = Object.freeze({
    authority: stageAuthority,
    bytes,
    checksum,
    key,
    reauthorize: () => stageAuthority,
  });
  const adapter = uploadClient({
    container,
    credential,
    endpoint,
    nowMs,
    scope,
  });

  const created = await adapter.putIfAbsent(input);
  const firstSnapshot = await snapshot(container.getBlockBlobClient(key));
  const idempotent = await adapter.putIfAbsent(input);
  await adapter.putIfAbsent({ ...input, key: retentionKey });
  const forgedBytes = Buffer.alloc(bytes.byteLength, 0x78);
  const forgedMd5 = createHash("md5").update(forgedBytes).digest();
  await container
    .getBlockBlobClient(forgedKey)
    .upload(forgedBytes, forgedBytes.byteLength, {
      blobHTTPHeaders: { blobContentMD5: forgedMd5 },
      metadata: { wfsha256: checksum },
    });
  const forgedMetadataRejectionCode = await adapterRejectionCode(adapter, {
    ...input,
    key: forgedKey,
  });
  const forgedSnapshot = await snapshot(
    container.getBlockBlobClient(forgedKey),
  );
  await foreignContainer
    .getBlockBlobClient(foreignKey)
    .upload(replacement, replacement.byteLength, {
      metadata: { wfsha256: sha256(replacement) },
    });

  const createCredential = blobCredential({
    blobName: key,
    container,
    credential,
    nowMs,
    permissions: "c",
  });
  const uploadBlob = azuriteBlockBlobClient(createCredential.blobUrl);
  const uploadToken = new URL(createCredential.blobUrl);
  const otherUrl = new URL(container.getBlockBlobClient(otherKey).url);
  otherUrl.search = uploadToken.search;
  const containerUrl = new URL(container.url);
  containerUrl.search = uploadToken.search;

  const unconditionalOverwriteDenied = await permissionDenied(() =>
    uploadBlob.upload(replacement, replacement.byteLength),
  );
  const crossResourceCreateDenied = await permissionDenied(() =>
    azuriteBlockBlobClient(otherUrl.toString()).upload(
      replacement,
      replacement.byteLength,
    ),
  );
  const uploadReadDenied = await permissionDenied(() =>
    azuriteBlobClient(createCredential.blobUrl).download(0, 1),
  );
  const uploadDeleteDenied = await permissionDenied(() =>
    azuriteBlobClient(createCredential.blobUrl).delete(),
  );
  const uploadMetadataMutationDenied = await permissionDenied(() =>
    azuriteBlobClient(createCredential.blobUrl).setMetadata({
      changed: "true",
    }),
  );
  const uploadListDenied = await permissionDenied(async () => {
    const page = new ContainerClient(containerUrl.toString(), azuritePipeline())
      .listBlobsFlat()
      .byPage({ maxPageSize: 1 });
    await page.next();
  });
  const putBlockBypassDenied = await permissionDenied(() =>
    uploadBlob.stageBlock(
      Buffer.from("block-1", "utf8").toString("base64"),
      replacement,
      replacement.byteLength,
    ),
  );
  const afterDeniedMutations = await snapshot(
    container.getBlockBlobClient(key),
  );

  const staleRejectionCode = await adapterRejectionCode(
    uploadClient({
      container,
      credential,
      endpoint,
      expiresAtMs: nowMs - 60_000,
      nowMs,
      scope,
    }),
    input,
  );
  const staleRejectedBeforeIo = new Set([
    "azure_blob_sas_expiry_invalid",
    "azure_blob_sas_not_active",
  ]).has(staleRejectionCode);
  const writeCapableRejectionCode = await adapterRejectionCode(
    uploadClient({
      container,
      createPermissions: "cw",
      credential,
      endpoint,
      nowMs,
      scope,
    }),
    input,
  );
  const writeCapableRejectedBeforeIo =
    writeCapableRejectionCode === "azure_blob_sas_policy_invalid";

  const restartEvidence = await restart();
  const afterRestart = await snapshot(container.getBlockBlobClient(key));
  const retryAfterRestart = await adapter.putIfAbsent(input);
  const exactStatePreserved =
    exactSnapshot(firstSnapshot, bytes, checksum, contentMd5) &&
    exactSnapshot(afterDeniedMutations, bytes, checksum, contentMd5) &&
    exactSnapshot(afterRestart, bytes, checksum, contentMd5);

  const deleteCredential = blobCredential({
    blobName: retentionKey,
    container,
    credential,
    nowMs,
    permissions: "d",
  });
  const deleteToken = new URL(deleteCredential.blobUrl);
  const foreignDeleteUrl = new URL(
    foreignContainer.getBlobClient(foreignKey).url,
  );
  foreignDeleteUrl.search = deleteToken.search;
  const foreignDeleteDenied = await permissionDenied(() =>
    azuriteBlobClient(foreignDeleteUrl.toString()).delete(),
  );
  const retentionDeleteCannotRead = await permissionDenied(() =>
    azuriteBlobClient(deleteCredential.blobUrl).download(0, 1),
  );
  const retention = retentionClient({
    container,
    credential,
    endpoint,
    nowMs,
  });
  const resultManifestId = "azure-object-manifest-1";
  const deleteAuthority = mutationAuthority(
    allocationId,
    nowMs,
    "artifact_delete",
    resultManifestId,
  );
  const expectedEntries = Object.freeze([
    Object.freeze({
      checksum,
      location: objectArtifactLocation(PROVIDER_ID, retentionKey),
      path: "retained.bin",
      sizeBytes: bytes.byteLength,
    }),
  ]);
  const retentionMutation = Object.freeze({
    authority: deleteAuthority,
    expectedEntries,
    identity,
    mutationFence: deleteAuthority.mutationFence,
    operationId: "azure-object-retention-operation-1",
    reauthorize: () => deleteAuthority,
    resultManifestId,
  });
  const deleted = await retention.deleteExactSetOnce(retentionMutation);
  const reconciled = await retention.reconcileExactSet(retentionMutation);
  const retriedDelete = await retention.deleteExactSetOnce(retentionMutation);
  const retriedReconciliation =
    await retention.reconcileExactSet(retentionMutation);

  const checks = {
    adapterConditionalCreate: created.created === true,
    createCredentialCannotDelete: uploadDeleteDenied,
    createCredentialCannotList: uploadListDenied,
    createCredentialCannotRead: uploadReadDenied,
    createCredentialCannotSetMetadata: uploadMetadataMutationDenied,
    crossResourceCreateDenied,
    exactStatePreserved,
    forgedMetadataCannotFakeIdempotency:
      forgedMetadataRejectionCode === "azure_blob_existing_object_mismatch" &&
      exactSnapshot(forgedSnapshot, forgedBytes, checksum, forgedMd5),
    foreignAllocationDeleteDenied: foreignDeleteDenied,
    idempotentRetry: idempotent.created === false,
    putBlockBypassDenied,
    restartReconciled: retryAfterRestart.created === false,
    retentionDeleteCannotRead,
    retentionDeleteIdempotent:
      deleted.status === "deleted" && retriedDelete.status === "deleted",
    retentionVerifiedAbsent:
      reconciled.status === "verified_absent" &&
      retriedReconciliation.status === "verified_absent",
    staleCredentialRejectedBeforeIo: staleRejectedBeforeIo,
    unconditionalOverwriteDenied,
    writeCapableCredentialRejectedBeforeIo: writeCapableRejectedBeforeIo,
  };
  const failedCheck = Object.entries(checks).find(
    ([, value]) => value !== true,
  )?.[0];
  if (failedCheck !== undefined)
    throw new Error(
      `azure_object_production_check_failed_${failedCheck.replaceAll(
        /[A-Z]/g,
        (character) => `_${character.toLowerCase()}`,
      )}`,
    );

  return Object.freeze({
    ...checks,
    apiVersionValidationBypass: false,
    cloudParityNotClaimed: true,
    exactProviderIdentity: Object.freeze({
      deletePermission: "d",
      fixture: "azurite",
      fixtureApiVersion: AZURITE_API_VERSION,
      fixtureImage,
      productionProvider: "azure_blob_storage",
      resourceType: "azure_blob_sas_sr_b",
      sdk: "@azure/storage-blob",
      sdkVersion: SDK_VERSION,
      uploadPermission: "c",
      verificationPermission: "r",
    }),
    immutableChecksum: `sha256:${checksum}`,
    restart: restartEvidence,
    sasAndAccountKeyExcludedFromEvidence: true,
    scopeComplete: true,
  });
}
