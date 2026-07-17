import { BlobClient } from "@azure/storage-blob";
import {
  type PrivateFixtureTransport,
  type ScopedCredential,
  validateScopedSas,
} from "./azure-sas-policy.js";
import type { ObjectMetadataReader } from "./index.js";

const DEFAULT_MAX_CREDENTIAL_LIFETIME_MS = 15 * 60_000;
const DEFAULT_MIN_CREDENTIAL_VALIDITY_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface AzureBlobReadCredential {
  readonly blobUrl: string;
  readonly expiresAtMs: number;
}

export interface AzureBlobReadCredentialProvider {
  readForKey(key: string): Promise<AzureBlobReadCredential>;
}

export interface AzureBlobMetadataSdkPort {
  properties(
    input: Readonly<{ abortSignal: AbortSignal; blobUrl: string }>,
  ): Promise<
    Readonly<{
      blobType?: string;
      contentMd5?: Uint8Array;
      contentLength?: number;
      metadata?: Readonly<Record<string, string>>;
    }>
  >;
}

export interface AzureBlobExactCreateOutcomeVerifier {
  verifyExact(
    input: Readonly<{
      checksum: string;
      contentMd5: Uint8Array;
      key: string;
      sizeBytes: number;
    }>,
  ): Promise<"absent" | "ambiguous" | "match" | "mismatch">;
}

export interface AzureBlobMetadataReaderConfig {
  readonly blobUrlForKey: (key: string) => string;
  readonly credentials: AzureBlobReadCredentialProvider;
  readonly maxCredentialLifetimeMs?: number;
  readonly minCredentialValidityMs?: number;
  readonly nowMs?: () => number;
  readonly requestTimeoutMs?: number;
  readonly sdk?: AzureBlobMetadataSdkPort;
}

export interface AzureBlobPrivateFixtureMetadataReaderConfig extends AzureBlobMetadataReaderConfig {
  readonly fixture: PrivateFixtureTransport;
}

export class AzureBlobMetadataReaderError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "AzureBlobMetadataReaderError";
  }
}

class AzureBlobMetadataSdkAdapter implements AzureBlobMetadataSdkPort {
  public async properties(
    input: Parameters<AzureBlobMetadataSdkPort["properties"]>[0],
  ): ReturnType<AzureBlobMetadataSdkPort["properties"]> {
    const properties = await new BlobClient(input.blobUrl).getProperties({
      abortSignal: input.abortSignal,
    });
    return Object.freeze({
      ...(properties.blobType === undefined
        ? {}
        : { blobType: properties.blobType }),
      ...(properties.contentMD5 === undefined
        ? {}
        : { contentMd5: Uint8Array.from(properties.contentMD5) }),
      ...(properties.contentLength === undefined
        ? {}
        : { contentLength: properties.contentLength }),
      ...(properties.metadata === undefined
        ? {}
        : { metadata: Object.freeze({ ...properties.metadata }) }),
    });
  }
}

function fail(code: string): never {
  throw new AzureBlobMetadataReaderError(code);
}

function statusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("statusCode" in error))
    return undefined;
  const value: unknown = error.statusCode;
  return typeof value === "number" ? value : undefined;
}

function resourceCredential(item: AzureBlobReadCredential): ScopedCredential {
  return Object.freeze({
    expiresAtMs: item.expiresAtMs,
    resourceUrl: item.blobUrl,
  });
}

function exactCreateOutcome(
  properties: Awaited<ReturnType<AzureBlobMetadataSdkPort["properties"]>>,
  expected: Readonly<{
    checksum: string;
    contentMd5: Uint8Array;
    sizeBytes: number;
  }>,
): "match" | "mismatch" {
  const storedChecksum = properties.metadata?.["wfsha256"];
  const storedContentMd5 = properties.contentMd5;
  if (
    properties.blobType !== "BlockBlob" ||
    typeof storedChecksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(storedChecksum) ||
    storedChecksum !== expected.checksum ||
    !Number.isSafeInteger(properties.contentLength) ||
    properties.contentLength !== expected.sizeBytes ||
    !(storedContentMd5 instanceof Uint8Array) ||
    storedContentMd5.byteLength !== 16 ||
    expected.contentMd5.byteLength !== 16 ||
    !Buffer.from(storedContentMd5).equals(Buffer.from(expected.contentMd5))
  )
    return "mismatch";
  return "match";
}

function createReader(
  config: AzureBlobMetadataReaderConfig,
  fixture?: PrivateFixtureTransport,
): ObjectMetadataReader {
  const nowMs = config.nowMs ?? Date.now;
  const maxLifetimeMs =
    config.maxCredentialLifetimeMs ?? DEFAULT_MAX_CREDENTIAL_LIFETIME_MS;
  const minValidityMs =
    config.minCredentialValidityMs ?? DEFAULT_MIN_CREDENTIAL_VALIDITY_MS;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    !Number.isSafeInteger(minValidityMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    minValidityMs < 1_000 ||
    maxLifetimeMs <= minValidityMs ||
    timeoutMs < 1_000
  )
    fail("azure_blob_metadata_reader_limits_invalid");
  const sdk = config.sdk ?? new AzureBlobMetadataSdkAdapter();

  return Object.freeze({
    async head(key: string) {
      let item: AzureBlobReadCredential;
      let expectedResourceUrl: string;
      try {
        [item, expectedResourceUrl] = await Promise.all([
          config.credentials.readForKey(key),
          Promise.resolve(config.blobUrlForKey(key)),
        ]);
      } catch {
        return fail("azure_blob_read_credential_issue_failed");
      }
      const blobUrl = validateScopedSas({
        credential: resourceCredential(item),
        expectedPermission: "r",
        expectedResourceType: "b",
        expectedResourceUrl,
        fail,
        ...(fixture === undefined ? {} : { fixture }),
        maxLifetimeMs,
        minValidityMs,
        nowMs: nowMs(),
      });
      let properties: Awaited<
        ReturnType<AzureBlobMetadataSdkPort["properties"]>
      >;
      try {
        properties = await sdk.properties({
          abortSignal: AbortSignal.timeout(timeoutMs),
          blobUrl,
        });
      } catch (error) {
        if (statusCode(error) === 404) return undefined;
        return fail("azure_blob_metadata_read_ambiguous");
      }
      const checksum = properties.metadata?.["wfsha256"];
      if (
        typeof checksum !== "string" ||
        !/^[a-f0-9]{64}$/u.test(checksum) ||
        !Number.isSafeInteger(properties.contentLength) ||
        (properties.contentLength ?? -1) < 0
      )
        fail("azure_blob_metadata_invalid");
      return Object.freeze({
        checksum,
        sizeBytes: properties.contentLength ?? 0,
      });
    },
  });
}

export function createAzureBlobExactMetadataReader(
  config: AzureBlobMetadataReaderConfig,
): ObjectMetadataReader {
  return createReader(config);
}

export function createAzureBlobPrivateFixtureExactMetadataReader(
  config: AzureBlobPrivateFixtureMetadataReaderConfig,
): ObjectMetadataReader {
  return createReader(config, config.fixture);
}

function createOutcomeVerifier(
  config: AzureBlobMetadataReaderConfig,
  fixture?: PrivateFixtureTransport,
): AzureBlobExactCreateOutcomeVerifier {
  const nowMs = config.nowMs ?? Date.now;
  const maxLifetimeMs =
    config.maxCredentialLifetimeMs ?? DEFAULT_MAX_CREDENTIAL_LIFETIME_MS;
  const minValidityMs =
    config.minCredentialValidityMs ?? DEFAULT_MIN_CREDENTIAL_VALIDITY_MS;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maxLifetimeMs) ||
    !Number.isSafeInteger(minValidityMs) ||
    !Number.isSafeInteger(timeoutMs) ||
    minValidityMs < 1_000 ||
    maxLifetimeMs <= minValidityMs ||
    timeoutMs < 1_000
  )
    fail("azure_blob_metadata_reader_limits_invalid");
  const sdk = config.sdk ?? new AzureBlobMetadataSdkAdapter();

  return Object.freeze({
    async verifyExact(
      input: Parameters<AzureBlobExactCreateOutcomeVerifier["verifyExact"]>[0],
    ) {
      if (
        !/^[a-f0-9]{64}$/u.test(input.checksum) ||
        !Number.isSafeInteger(input.sizeBytes) ||
        input.sizeBytes < 0 ||
        input.contentMd5.byteLength !== 16
      )
        return "mismatch";
      let item: AzureBlobReadCredential;
      let expectedResourceUrl: string;
      try {
        [item, expectedResourceUrl] = await Promise.all([
          config.credentials.readForKey(input.key),
          Promise.resolve(config.blobUrlForKey(input.key)),
        ]);
      } catch {
        return "ambiguous";
      }
      let blobUrl: string;
      try {
        blobUrl = validateScopedSas({
          credential: resourceCredential(item),
          expectedPermission: "r",
          expectedResourceType: "b",
          expectedResourceUrl,
          fail,
          ...(fixture === undefined ? {} : { fixture }),
          maxLifetimeMs,
          minValidityMs,
          nowMs: nowMs(),
        });
      } catch {
        return "ambiguous";
      }
      try {
        const properties = await sdk.properties({
          abortSignal: AbortSignal.timeout(timeoutMs),
          blobUrl,
        });
        return exactCreateOutcome(properties, input);
      } catch (error) {
        return statusCode(error) === 404 ? "absent" : "ambiguous";
      }
    },
  });
}

export function createAzureBlobExactCreateOutcomeVerifier(
  config: AzureBlobMetadataReaderConfig,
): AzureBlobExactCreateOutcomeVerifier {
  return createOutcomeVerifier(config);
}

export function createAzureBlobPrivateFixtureExactCreateOutcomeVerifier(
  config: AzureBlobPrivateFixtureMetadataReaderConfig,
): AzureBlobExactCreateOutcomeVerifier {
  return createOutcomeVerifier(config, config.fixture);
}
