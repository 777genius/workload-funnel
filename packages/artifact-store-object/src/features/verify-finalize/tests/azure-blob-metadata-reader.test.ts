import { describe, expect, it } from "vitest";

import {
  createAzureBlobExactCreateOutcomeVerifier,
  createAzureBlobExactMetadataReader,
  type AzureBlobMetadataSdkPort,
  type AzureBlobReadCredentialProvider,
} from "../azure-blob-metadata-reader.js";

const now = Date.parse("2026-07-16T12:00:00.000Z");
const key = "allocation-1/generation-1/artifact.bin";
const checksum = "a".repeat(64);
const contentMd5 = Uint8Array.from({ length: 16 }, (_, index) => index);

function sas(itemKey = key) {
  const query = new URLSearchParams({
    se: new Date(now + 60_000).toISOString(),
    sig: "fixture-signature",
    sp: "r",
    spr: "https",
    sr: "b",
    sv: "2026-06-06",
  });
  return Object.freeze({
    blobUrl: `https://blob.example.test/container/${itemKey}?${query.toString()}`,
    expiresAtMs: now + 60_000,
  });
}

function reader(
  sdk: AzureBlobMetadataSdkPort,
  credentials: AzureBlobReadCredentialProvider = {
    readForKey: (itemKey) => Promise.resolve(sas(itemKey)),
  },
) {
  return createAzureBlobExactMetadataReader({
    blobUrlForKey: (itemKey) =>
      `https://blob.example.test/container/${itemKey}`,
    credentials,
    nowMs: () => now,
    sdk,
  });
}

function verifier(
  sdk: AzureBlobMetadataSdkPort,
  credentials: AzureBlobReadCredentialProvider = {
    readForKey: (itemKey) => Promise.resolve(sas(itemKey)),
  },
) {
  return createAzureBlobExactCreateOutcomeVerifier({
    blobUrlForKey: (itemKey) =>
      `https://blob.example.test/container/${itemKey}`,
    credentials,
    nowMs: () => now,
    sdk,
  });
}

const exactInput = Object.freeze({
  checksum,
  contentMd5,
  key,
  sizeBytes: 7,
});

describe("Azure Blob exact metadata reader", () => {
  it("returns only the immutable SHA-256 metadata and exact size", async () => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.resolve({
          blobType: "AppendBlob",
          contentLength: 7,
          contentMd5: Uint8Array.of(1),
          metadata: { wfsha256: checksum },
        }),
    };
    await expect(reader(sdk).head(key)).resolves.toEqual({
      checksum,
      sizeBytes: 7,
    });
  });

  it("matches a BlockBlob only when SHA-256, size, and server Content-MD5 are exact", async () => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.resolve({
          blobType: "BlockBlob",
          contentLength: 7,
          contentMd5,
          metadata: { wfsha256: checksum },
        }),
    };
    await expect(verifier(sdk).verifyExact(exactInput)).resolves.toBe("match");
  });

  it.each([
    ["different Content-MD5", Uint8Array.from(contentMd5, (byte) => byte ^ 1)],
    ["missing Content-MD5", undefined],
    ["malformed Content-MD5", Uint8Array.of(1, 2, 3)],
  ])(
    "rejects %s even when SHA-256 and size match",
    async (_name, storedMd5) => {
      const sdk: AzureBlobMetadataSdkPort = {
        properties: () =>
          Promise.resolve({
            blobType: "BlockBlob",
            contentLength: 7,
            ...(storedMd5 === undefined ? {} : { contentMd5: storedMd5 }),
            metadata: { wfsha256: checksum },
          }),
      };
      await expect(verifier(sdk).verifyExact(exactInput)).resolves.toBe(
        "mismatch",
      );
    },
  );

  it.each([
    ["missing SHA-256 metadata", undefined, 7],
    ["malformed SHA-256 metadata", "not-a-sha256", 7],
    ["different SHA-256 metadata", "b".repeat(64), 7],
    ["different size", checksum, 8],
    ["missing size", checksum, undefined],
  ])("rejects %s", async (_name, storedChecksum, contentLength) => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.resolve({
          blobType: "BlockBlob",
          ...(contentLength === undefined ? {} : { contentLength }),
          contentMd5,
          ...(storedChecksum === undefined
            ? {}
            : { metadata: { wfsha256: storedChecksum } }),
        }),
    };
    await expect(verifier(sdk).verifyExact(exactInput)).resolves.toBe(
      "mismatch",
    );
  });

  it.each([
    ["missing blob type", undefined],
    ["non-BlockBlob type", "AppendBlob"],
  ])("rejects %s", async (_name, blobType) => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.resolve({
          ...(blobType === undefined ? {} : { blobType }),
          contentLength: 7,
          contentMd5,
          metadata: { wfsha256: checksum },
        }),
    };
    await expect(verifier(sdk).verifyExact(exactInput)).resolves.toBe(
      "mismatch",
    );
  });

  it("classifies only 404 as absent and all other read failures as ambiguous", async () => {
    const absent: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.reject(
          Object.assign(new Error("missing"), { statusCode: 404 }),
        ),
    };
    await expect(verifier(absent).verifyExact(exactInput)).resolves.toBe(
      "absent",
    );

    const timeout: AzureBlobMetadataSdkPort = {
      properties: () => Promise.reject(new Error("timeout")),
    };
    await expect(verifier(timeout).verifyExact(exactInput)).resolves.toBe(
      "ambiguous",
    );
  });

  it("treats only an exact 404 as absent", async () => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () =>
        Promise.reject(
          Object.assign(new Error("raw url"), { statusCode: 404 }),
        ),
    };
    await expect(reader(sdk).head(key)).resolves.toBeUndefined();
    const sensitive = ["sig", "hidden-fixture-value"].join("=");
    const ambiguous: AzureBlobMetadataSdkPort = {
      properties: () => Promise.reject(new Error(`raw sas ${sensitive}`)),
    };
    await expect(reader(ambiguous).head(key)).rejects.toMatchObject({
      code: "azure_blob_metadata_read_ambiguous",
    });
  });

  it("sanitizes credential issuer failures", async () => {
    const sdk: AzureBlobMetadataSdkPort = {
      properties: () => Promise.resolve({}),
    };
    const credentials: AzureBlobReadCredentialProvider = {
      readForKey: () =>
        Promise.reject(new Error(["sig", "do-not-log"].join("="))),
    };
    let message = "none";
    try {
      await reader(sdk, credentials).head(key);
    } catch (error) {
      message = error instanceof Error ? error.message : "unknown";
    }
    expect(message).toBe("azure_blob_read_credential_issue_failed");
  });
});
