import { createHash } from "node:crypto";

import { BlockBlobClient } from "@azure/storage-blob";
import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { ScopedUploadIdentity } from "@workload-funnel/node-execution/result-staging-reporting";
import type { ArtifactMutationAuthorityReceipt } from "@workload-funnel/workload-control/result-management";
import {
  type PrivateFixtureTransport,
  type ScopedCredential,
  validateScopedSas,
} from "./azure-sas-policy.js";
import type {
  ObjectStagePutReceipt,
  ScopedCreateOnlyObjectClient,
} from "./index.js";

const DEFAULT_MAX_CREDENTIAL_LIFETIME_MS = 15 * 60_000;
const DEFAULT_MIN_CREDENTIAL_VALIDITY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_SINGLE_PUT_BYTES = 256 * 1024 * 1024;

export interface AzureBlobScopedCredential {
  readonly blobUrl: string;
  readonly expiresAtMs: number;
}

export interface AzureBlobCreateCredentialProvider {
  createForKey(key: string): Promise<AzureBlobScopedCredential>;
}

export interface AzureBlobCreateOnlyVerifier {
  verifyExact(
    input: Readonly<{
      checksum: string;
      contentMd5: Uint8Array;
      key: string;
      sizeBytes: number;
    }>,
  ): Promise<"absent" | "ambiguous" | "match" | "mismatch">;
}

export interface AzureBlobSdkPort {
  upload(
    input: Readonly<{
      abortSignal: AbortSignal;
      blobUrl: string;
      bytes: Uint8Array;
      contentMd5: Uint8Array;
      sha256: string;
    }>,
  ): Promise<Readonly<{ contentMd5?: Uint8Array }>>;
}

export interface AzureBlobCreateOnlyClientConfig {
  readonly blobUrlForKey: (key: string) => string;
  readonly credentials: AzureBlobCreateCredentialProvider;
  readonly maxCredentialLifetimeMs?: number;
  readonly maxSinglePutBytes?: number;
  readonly minCredentialValidityMs?: number;
  readonly nowMs?: () => number;
  readonly requestTimeoutMs?: number;
  readonly scope: ScopedUploadIdentity;
  readonly sdk?: AzureBlobSdkPort;
  readonly verifier: AzureBlobCreateOnlyVerifier;
}

export interface AzureBlobPrivateFixtureClientConfig extends AzureBlobCreateOnlyClientConfig {
  readonly fixture: PrivateFixtureTransport;
}

export class AzureBlobCreateOnlyError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AzureBlobCreateOnlyError";
  }
}

class AzureBlobSdkAdapter implements AzureBlobSdkPort {
  public async upload(
    input: Parameters<AzureBlobSdkPort["upload"]>[0],
  ): ReturnType<AzureBlobSdkPort["upload"]> {
    const response = await new BlockBlobClient(input.blobUrl).upload(
      input.bytes,
      input.bytes.byteLength,
      {
        abortSignal: input.abortSignal,
        blobHTTPHeaders: { blobContentMD5: input.contentMd5 },
        conditions: { ifNoneMatch: "*" },
        metadata: { wfsha256: input.sha256 },
      },
    );
    return Object.freeze({
      ...(response.contentMD5 === undefined
        ? {}
        : { contentMd5: response.contentMD5 }),
    });
  }
}

function fail(code: string): never {
  throw new AzureBlobCreateOnlyError(code);
}

function assertScope(scope: ScopedUploadIdentity): void {
  const candidate = scope as unknown as Readonly<Record<string, unknown>>;
  const prefix = candidate["prefix"];
  const permissions = candidate["permissions"];
  if (
    typeof prefix !== "string" ||
    !prefix.endsWith("/") ||
    prefix.startsWith("/") ||
    prefix.includes("\\") ||
    prefix.includes("\u0000") ||
    prefix !== prefix.normalize("NFC") ||
    prefix
      .split("/")
      .some((part, index, values) =>
        index === values.length - 1
          ? part !== ""
          : part === "" || part === "." || part === "..",
      ) ||
    !Array.isArray(permissions) ||
    permissions.length !== 1 ||
    permissions[0] !== "create" ||
    candidate["canList"] !== false ||
    candidate["canRead"] !== false ||
    candidate["canOverwrite"] !== false ||
    candidate["canDelete"] !== false
  )
    fail("azure_blob_upload_scope_invalid");
}

function assertKey(key: string, scope: ScopedUploadIdentity): void {
  const parts = key.split("/");
  if (
    !key.startsWith(scope.prefix) ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\u0000") ||
    key !== key.normalize("NFC") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  )
    fail("azure_blob_key_outside_scope");
}

function sameBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return left !== undefined && Buffer.from(left).equals(Buffer.from(right));
}

function exactFreshAuthority(
  authority: ArtifactMutationAuthorityReceipt,
  scope: ScopedUploadIdentity,
  nowMs: number,
): number {
  const fence: MutationFence = authority.mutationFence;
  try {
    validateMutationFence(fence);
  } catch {
    fail("azure_blob_mutation_authority_invalid");
  }
  if (
    authority.mutationFenceFingerprint !== fingerprintMutationFence(fence) ||
    authority.effectScopeKey !== fence.effectScopeKey ||
    fence.allocationId !== scope.allocationId ||
    fence.desiredEffect !== "artifact_stage" ||
    fence.requiredGate !== "result_finalize" ||
    typeof fence.notBefore !== "number" ||
    typeof fence.notAfter !== "number" ||
    nowMs < fence.notBefore ||
    nowMs >= fence.notAfter
  )
    fail("azure_blob_mutation_authority_invalid");
  return fence.notAfter;
}

function exactReauthorization(
  expected: ArtifactMutationAuthorityReceipt,
  installed: ArtifactMutationAuthorityReceipt,
  scope: ScopedUploadIdentity,
  nowMs: number,
): void {
  exactFreshAuthority(installed, scope, nowMs);
  if (
    installed.mutationFenceFingerprint !== expected.mutationFenceFingerprint ||
    installed.effectScopeKey !== expected.effectScopeKey ||
    installed.durableSequence !== expected.durableSequence ||
    installed.operationId !== expected.operationId ||
    installed.writerIdentity !== expected.writerIdentity
  )
    fail("azure_blob_mutation_authority_invalid");
}

function abortSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function resourceCredential(item: AzureBlobScopedCredential): ScopedCredential {
  return Object.freeze({
    expiresAtMs: item.expiresAtMs,
    resourceUrl: item.blobUrl,
  });
}

function createClient(
  config: AzureBlobCreateOnlyClientConfig,
  fixture?: PrivateFixtureTransport,
): ScopedCreateOnlyObjectClient {
  assertScope(config.scope);
  const nowMs = config.nowMs ?? Date.now;
  const maxLifetimeMs =
    config.maxCredentialLifetimeMs ?? DEFAULT_MAX_CREDENTIAL_LIFETIME_MS;
  const minValidityMs =
    config.minCredentialValidityMs ?? DEFAULT_MIN_CREDENTIAL_VALIDITY_MS;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxSinglePutBytes =
    config.maxSinglePutBytes ?? DEFAULT_MAX_SINGLE_PUT_BYTES;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    !Number.isSafeInteger(minValidityMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    !Number.isSafeInteger(maxSinglePutBytes) ||
    minValidityMs < 1_000 ||
    maxLifetimeMs <= minValidityMs ||
    timeoutMs < 1_000 ||
    maxSinglePutBytes < 1
  )
    fail("azure_blob_client_limits_invalid");
  const sdk = config.sdk ?? new AzureBlobSdkAdapter();

  const credential = async (
    key: string,
    latestExpiryMs: number,
  ): Promise<string> => {
    let item: AzureBlobScopedCredential;
    let expectedResourceUrl: string;
    try {
      [item, expectedResourceUrl] = await Promise.all([
        config.credentials.createForKey(key),
        Promise.resolve(config.blobUrlForKey(key)),
      ]);
    } catch {
      return fail("azure_blob_credential_issue_failed");
    }
    return validateScopedSas({
      credential: resourceCredential(item),
      expectedPermission: "c",
      expectedResourceType: "b",
      expectedResourceUrl,
      fail,
      ...(fixture === undefined ? {} : { fixture }),
      maxLifetimeMs,
      minValidityMs,
      latestExpiryMs,
      nowMs: nowMs(),
    });
  };

  const verify = async (
    key: string,
    sizeBytes: number,
    checksum: string,
    contentMd5: Uint8Array,
  ): Promise<"absent" | "ambiguous" | "match" | "mismatch"> => {
    try {
      return await config.verifier.verifyExact({
        checksum,
        contentMd5,
        key,
        sizeBytes,
      });
    } catch {
      return "ambiguous";
    }
  };

  return Object.freeze({
    capabilities: Object.freeze({
      createOnly: true,
      finalMutationFencing: true,
      scopedCredentials: true,
      serverChecksum: true,
    }),
    async putIfAbsent(
      input: Parameters<ScopedCreateOnlyObjectClient["putIfAbsent"]>[0],
    ): Promise<ObjectStagePutReceipt> {
      assertKey(input.key, config.scope);
      const latestExpiryMs = exactFreshAuthority(
        input.authority,
        config.scope,
        nowMs(),
      );
      if (
        !/^[a-f0-9]{64}$/u.test(input.checksum) ||
        input.bytes.byteLength > maxSinglePutBytes
      )
        fail("azure_blob_put_input_invalid");
      const contentMd5 = createHash("md5").update(input.bytes).digest();
      const blobUrl = await credential(input.key, latestExpiryMs);

      // Credential issuance may block while durable authority is superseded.
      // Re-authorize against the store immediately before the SDK mutation.
      const mutationAt = nowMs();
      let installed: ArtifactMutationAuthorityReceipt;
      try {
        installed = input.reauthorize(mutationAt);
      } catch {
        return fail("azure_blob_mutation_authority_invalid");
      }
      exactReauthorization(
        input.authority,
        installed,
        config.scope,
        mutationAt,
      );
      let created = false;
      let uploadError: unknown;
      try {
        const uploaded = await sdk.upload({
          abortSignal: abortSignal(timeoutMs),
          blobUrl,
          bytes: input.bytes,
          contentMd5,
          sha256: input.checksum,
        });
        if (
          uploaded.contentMd5 !== undefined &&
          !sameBytes(uploaded.contentMd5, contentMd5)
        )
          fail("azure_blob_upload_checksum_mismatch");
        created = true;
      } catch (error) {
        uploadError = error;
      }

      const verification = await verify(
        input.key,
        input.bytes.byteLength,
        input.checksum,
        contentMd5,
      );
      if (verification === "mismatch")
        fail("azure_blob_existing_object_mismatch");
      if (verification !== "match") {
        if (uploadError !== undefined)
          fail("azure_blob_create_outcome_ambiguous");
        fail(
          verification === "absent"
            ? "azure_blob_verified_object_absent"
            : "azure_blob_verification_ambiguous",
        );
      }
      if (
        uploadError instanceof AzureBlobCreateOnlyError &&
        uploadError.code === "azure_blob_upload_checksum_mismatch"
      )
        throw uploadError;
      return Object.freeze({
        checksum: input.checksum,
        created,
        key: input.key,
        sizeBytes: input.bytes.byteLength,
      });
    },
    scope: config.scope,
  });
}

export function createAzureBlobScopedCreateOnlyClient(
  config: AzureBlobCreateOnlyClientConfig,
): ScopedCreateOnlyObjectClient {
  return createClient(config);
}

export function createAzureBlobPrivateFixtureScopedCreateOnlyClient(
  config: AzureBlobPrivateFixtureClientConfig,
): ScopedCreateOnlyObjectClient {
  return createClient(config, config.fixture);
}
