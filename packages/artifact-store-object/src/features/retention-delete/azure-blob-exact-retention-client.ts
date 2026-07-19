import { createHash } from "node:crypto";

import { BlobClient } from "@azure/storage-blob";
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import {
  type PrivateFixtureTransport,
  type ScopedCredential,
  validateScopedSas,
} from "./azure-sas-policy.js";
import type {
  ObjectDeleteProviderReceipt,
  ObjectDeleteReconciliationProviderReceipt,
  ObjectRetentionClient,
  ObjectRetentionMutation,
} from "./index.js";

const DEFAULT_MAX_CREDENTIAL_LIFETIME_MS = 15 * 60_000;
const DEFAULT_MIN_CREDENTIAL_VALIDITY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface AzureBlobRetentionCredential {
  readonly blobUrl: string;
  readonly expiresAtMs: number;
}

export interface AzureBlobRetentionDeleteCredentialProvider {
  deleteForKey(key: string): Promise<AzureBlobRetentionCredential>;
}

export interface AzureBlobRetentionReadCredentialProvider {
  readForKey(key: string): Promise<AzureBlobRetentionCredential>;
}

export interface AzureBlobRetentionSdkPort {
  delete(
    input: Readonly<{
      abortSignal: AbortSignal;
      blobUrl: string;
      etag: string;
    }>,
  ): Promise<void>;
  properties(
    input: Readonly<{ abortSignal: AbortSignal; blobUrl: string }>,
  ): Promise<
    Readonly<{
      contentLength?: number;
      etag?: string;
      metadata?: Readonly<Record<string, string>>;
    }>
  >;
}

export interface AzureBlobExactRetentionClientConfig {
  readonly blobUrlForKey: (key: string) => string;
  readonly deleteCredentials: AzureBlobRetentionDeleteCredentialProvider;
  readonly maxCredentialLifetimeMs?: number;
  readonly minCredentialValidityMs?: number;
  readonly nowMs?: () => number;
  readonly providerId: string;
  readonly readCredentials: AzureBlobRetentionReadCredentialProvider;
  readonly requestTimeoutMs?: number;
  readonly sdk?: AzureBlobRetentionSdkPort;
}

export interface AzureBlobPrivateFixtureExactRetentionClientConfig extends AzureBlobExactRetentionClientConfig {
  readonly fixture: PrivateFixtureTransport;
}

export class AzureBlobRetentionError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AzureBlobRetentionError";
  }
}

class AzureBlobRetentionSdkAdapter implements AzureBlobRetentionSdkPort {
  public async delete(
    input: Parameters<AzureBlobRetentionSdkPort["delete"]>[0],
  ): Promise<void> {
    await new BlobClient(input.blobUrl).delete({
      abortSignal: input.abortSignal,
      conditions: { ifMatch: input.etag },
    });
  }

  public async properties(
    input: Parameters<AzureBlobRetentionSdkPort["properties"]>[0],
  ): ReturnType<AzureBlobRetentionSdkPort["properties"]> {
    const properties = await new BlobClient(input.blobUrl).getProperties({
      abortSignal: input.abortSignal,
    });
    return Object.freeze({
      ...(properties.contentLength === undefined
        ? {}
        : { contentLength: properties.contentLength }),
      ...(properties.etag === undefined ? {} : { etag: properties.etag }),
      ...(properties.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...properties.metadata }) }),
    });
  }
}

function fail(code: string): never {
  throw new AzureBlobRetentionError(code);
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error))
    return undefined;
  const value: unknown = error.statusCode;
  return typeof value === "number" ? value : undefined;
}

function exactFreshAuthority(
  command: ObjectRetentionMutation,
  nowMs: number,
): number {
  const fence: MutationFence = command.mutationFence;
  try {
    validateMutationFence(fence);
  } catch {
    fail("azure_blob_retention_authority_invalid");
  }
  if (
    fingerprintMutationFence(fence) !==
      command.authority.mutationFenceFingerprint ||
    fingerprintMutationFence(command.authority.mutationFence) !==
      command.authority.mutationFenceFingerprint ||
    command.authority.effectScopeKey !== fence.effectScopeKey ||
    fence.desiredEffect !== "artifact_delete" ||
    fence.requiredGate !== "result_retention" ||
    fence.effectScopeKey !== `artifact-delete:${command.resultManifestId}` ||
    typeof fence.allocationId !== "string" ||
    !command.identity.startsWith(
      `${fence.allocationId}/${fence.executionGeneration}/`,
    ) ||
    typeof fence.notBefore !== "number" ||
    typeof fence.notAfter !== "number" ||
    nowMs < fence.notBefore ||
    nowMs >= fence.notAfter
  )
    fail("azure_blob_retention_authority_invalid");
  return fence.notAfter;
}

function sameAuthorityReceipt(
  left: ObjectRetentionMutation["authority"],
  right: ObjectRetentionMutation["authority"],
): boolean {
  return (
    left.durableSequence === right.durableSequence &&
    left.effectScopeKey === right.effectScopeKey &&
    left.mutationFenceFingerprint === right.mutationFenceFingerprint &&
    left.operationId === right.operationId &&
    left.writerIdentity === right.writerIdentity &&
    fingerprintMutationFence(left.mutationFence) ===
      fingerprintMutationFence(right.mutationFence)
  );
}

function durablyReauthorize(
  command: ObjectRetentionMutation,
  nowMs: number,
): void {
  let refreshed: ObjectRetentionMutation["authority"];
  try {
    refreshed = command.reauthorize(nowMs);
    validateMutationFence(refreshed.mutationFence);
  } catch {
    return fail("azure_blob_retention_authority_invalid");
  }
  if (!sameAuthorityReceipt(command.authority, refreshed))
    fail("azure_blob_retention_authority_invalid");
  exactFreshAuthority(command, nowMs);
}

function resourceCredential(
  item: AzureBlobRetentionCredential,
): ScopedCredential {
  return Object.freeze({
    expiresAtMs: item.expiresAtMs,
    resourceUrl: item.blobUrl,
  });
}

interface BoundRetentionEntry {
  readonly checksum: string;
  readonly key: string;
  readonly location: string;
  readonly sizeBytes: number;
}

function receiptId(
  command: ObjectRetentionMutation,
  status: string,
  entries: readonly BoundRetentionEntry[],
): string {
  return `azure-blob-retention-v1-${createHash("sha256")
    .update(
      JSON.stringify({
        entries,
        fence: fingerprintMutationFence(command.mutationFence),
        operationId: command.operationId,
        status,
      }),
    )
    .digest("hex")}`;
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
    fail("azure_blob_retention_entry_invalid");
  return `${identity}/${pathSegments
    .map((segment) => Buffer.from(segment).toString("base64url"))
    .join("/")}`;
}

function objectArtifactKeyFromLocation(
  providerId: string,
  location: string,
): string {
  const prefix = `object+wf://${providerId}/`;
  if (!location.startsWith(prefix))
    fail("azure_blob_retention_location_mismatch");
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
    fail("azure_blob_retention_location_mismatch");
  return key;
}

function boundEntries(
  command: ObjectRetentionMutation,
  providerId: string,
): readonly Readonly<BoundRetentionEntry>[] {
  return Object.freeze(
    command.expectedEntries
      .map((entry) => {
        const key = objectArtifactKey(command.identity, entry.path);
        if (objectArtifactKeyFromLocation(providerId, entry.location) !== key)
          fail("azure_blob_retention_location_mismatch");
        if (
          !/^[a-f0-9]{64}$/u.test(entry.checksum) ||
          !Number.isSafeInteger(entry.sizeBytes) ||
          entry.sizeBytes < 0
        )
          fail("azure_blob_retention_entry_invalid");
        return Object.freeze({
          checksum: entry.checksum,
          key,
          location: entry.location,
          sizeBytes: entry.sizeBytes,
        });
      })
      .sort(
        (left, right) =>
          left.key.localeCompare(right.key) ||
          left.checksum.localeCompare(right.checksum) ||
          left.sizeBytes - right.sizeBytes ||
          left.location.localeCompare(right.location),
      ),
  );
}

function createClient(
  config: AzureBlobExactRetentionClientConfig,
  fixture?: PrivateFixtureTransport,
): ObjectRetentionClient {
  const nowMs = config.nowMs ?? Date.now;
  const maxLifetimeMs =
    config.maxCredentialLifetimeMs ?? DEFAULT_MAX_CREDENTIAL_LIFETIME_MS;
  const minValidityMs =
    config.minCredentialValidityMs ?? DEFAULT_MIN_CREDENTIAL_VALIDITY_MS;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !/^[a-z0-9][a-z0-9._-]*$/u.test(config.providerId) ||
    !Number.isSafeInteger(maxLifetimeMs) ||
    !Number.isSafeInteger(minValidityMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    minValidityMs < 1_000 ||
    maxLifetimeMs <= minValidityMs ||
    timeoutMs < 1_000
  )
    fail("azure_blob_retention_config_invalid");
  const sdk = config.sdk ?? new AzureBlobRetentionSdkAdapter();

  const credential = async (
    key: string,
    permission: "d" | "r",
    authorityNotAfterMs: number,
  ): Promise<string> => {
    let item: AzureBlobRetentionCredential;
    let expectedResourceUrl: string;
    try {
      [item, expectedResourceUrl] = await Promise.all([
        permission === "d"
          ? config.deleteCredentials.deleteForKey(key)
          : config.readCredentials.readForKey(key),
        Promise.resolve(config.blobUrlForKey(key)),
      ]);
    } catch {
      return fail("azure_blob_retention_credential_issue_failed");
    }
    const blobUrl = validateScopedSas({
      credential: resourceCredential(item),
      expectedPermission: permission,
      expectedResourceType: "b",
      expectedResourceUrl,
      fail,
      ...(fixture === undefined ? {} : { fixture }),
      maxLifetimeMs,
      minValidityMs,
      nowMs: nowMs(),
    });
    const sasExpiresAtMs = Date.parse(
      new URL(blobUrl).searchParams.get("se") ?? "",
    );
    if (
      !Number.isFinite(sasExpiresAtMs) ||
      sasExpiresAtMs > authorityNotAfterMs
    )
      fail("azure_blob_retention_credential_outlives_authority");
    return blobUrl;
  };

  const head = async (
    key: string,
    authorityNotAfterMs: number,
  ): Promise<
    Readonly<{ checksum: string; etag: string; sizeBytes: number }> | undefined
  > => {
    const blobUrl = await credential(key, "r", authorityNotAfterMs);
    let properties: Awaited<
      ReturnType<AzureBlobRetentionSdkPort["properties"]>
    >;
    try {
      properties = await sdk.properties({
        abortSignal: AbortSignal.timeout(timeoutMs),
        blobUrl,
      });
    } catch (error) {
      if (statusCode(error) === 404) return undefined;
      return fail("azure_blob_retention_reconciliation_ambiguous");
    }
    const checksum = properties.metadata?.["wfsha256"];
    if (
      typeof checksum !== "string" ||
      !/^[a-f0-9]{64}$/u.test(checksum) ||
      typeof properties.etag !== "string" ||
      properties.etag.length === 0 ||
      !Number.isSafeInteger(properties.contentLength) ||
      (properties.contentLength ?? -1) < 0
    )
      fail("azure_blob_retention_metadata_invalid");
    return Object.freeze({
      checksum,
      etag: properties.etag,
      sizeBytes: properties.contentLength ?? 0,
    });
  };

  const exactHead = async (
    entry: Readonly<BoundRetentionEntry>,
    authorityNotAfterMs: number,
  ) => {
    const state = await head(entry.key, authorityNotAfterMs);
    if (
      state !== undefined &&
      (state.checksum !== entry.checksum || state.sizeBytes !== entry.sizeBytes)
    )
      fail("azure_blob_retention_object_replaced");
    return state;
  };

  return Object.freeze({
    capabilities: Object.freeze({
      exactResourceDeleteOnly: true,
      finalMutationFencing: true,
      retentionCredential: true,
    }),
    async deleteExactSetOnce(
      command: ObjectRetentionMutation,
    ): Promise<ObjectDeleteProviderReceipt> {
      const authorityNotAfterMs = exactFreshAuthority(command, nowMs());
      const entries = boundEntries(command, config.providerId);
      for (const entry of entries) {
        const state = await exactHead(entry, authorityNotAfterMs);
        if (state === undefined) continue;
        const blobUrl = await credential(entry.key, "d", authorityNotAfterMs);
        // Credential issuance can be slow or supersede durable authority.
        durablyReauthorize(command, nowMs());
        try {
          await sdk.delete({
            abortSignal: AbortSignal.timeout(timeoutMs),
            blobUrl,
            etag: state.etag,
          });
        } catch (error) {
          if (statusCode(error) !== 404) {
            const status = "unknown";
            return Object.freeze({
              mutationFence: command.mutationFence,
              mutationFenceFingerprint: fingerprintMutationFence(
                command.mutationFence,
              ),
              operationId: command.operationId,
              providerId: config.providerId,
              providerReceiptId: receiptId(command, status, entries),
              resultManifestId: command.resultManifestId,
              status,
            });
          }
        }
      }
      const status = "deleted";
      return Object.freeze({
        mutationFence: command.mutationFence,
        mutationFenceFingerprint: fingerprintMutationFence(
          command.mutationFence,
        ),
        operationId: command.operationId,
        providerId: config.providerId,
        providerReceiptId: receiptId(command, status, entries),
        resultManifestId: command.resultManifestId,
        status,
      });
    },
    async reconcileExactSet(
      command: ObjectRetentionMutation,
    ): Promise<ObjectDeleteReconciliationProviderReceipt> {
      const authorityNotAfterMs = exactFreshAuthority(command, nowMs());
      const entries = boundEntries(command, config.providerId);
      let present = false;
      for (const entry of entries) {
        if ((await exactHead(entry, authorityNotAfterMs)) !== undefined)
          present = true;
      }
      const status = present ? "still_present" : "verified_absent";
      return Object.freeze({
        mutationFence: command.mutationFence,
        mutationFenceFingerprint: fingerprintMutationFence(
          command.mutationFence,
        ),
        operationId: command.operationId,
        providerId: config.providerId,
        providerReceiptId: receiptId(command, status, entries),
        resultManifestId: command.resultManifestId,
        status,
      });
    },
  });
}

export function createAzureBlobExactRetentionClient(
  config: AzureBlobExactRetentionClientConfig,
): ObjectRetentionClient {
  return createClient(config);
}

export function createAzureBlobPrivateFixtureExactRetentionClient(
  config: AzureBlobPrivateFixtureExactRetentionClientConfig,
): ObjectRetentionClient {
  return createClient(config, config.fixture);
}
