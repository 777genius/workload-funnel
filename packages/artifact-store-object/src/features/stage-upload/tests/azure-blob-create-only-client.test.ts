import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { ScopedUploadIdentity } from "@workload-funnel/node-execution/result-staging-reporting";
import type { ArtifactMutationAuthorityReceipt } from "@workload-funnel/workload-control/result-management";

import {
  createAzureBlobScopedCreateOnlyClient,
  type AzureBlobCreateCredentialProvider,
  type AzureBlobCreateOnlyVerifier,
  type AzureBlobSdkPort,
} from "../azure-blob-create-only-client.js";

const now = Date.parse("2026-07-16T12:00:00.000Z");
const prefix = "allocation-1/generation-1/";
const key = `${prefix}artifact.bin`;
const bytes = Buffer.from("payload");
const checksum = createHash("sha256").update(bytes).digest("hex");
const md5 = createHash("md5").update(bytes).digest();
const scope: ScopedUploadIdentity = Object.freeze({
  allocationId: "allocation-1",
  canDelete: false,
  canList: false,
  canOverwrite: false,
  canRead: false,
  permissions: Object.freeze(["create"] as const),
  prefix,
});

function fence(): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "artifact_stage",
    effectScopeKey: "artifact-stage:execution-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    notAfter: now + 60_000,
    notBefore: now - 60_000,
    operationGateRevision: 1,
    ownerFence: 2,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: "artifact-stage:execution-1",
  });
}

function authority(): ArtifactMutationAuthorityReceipt {
  const mutationFence = fence();
  return Object.freeze({
    durableSequence: 1,
    effectScopeKey: mutationFence.effectScopeKey,
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    operationId: "authority-1",
    writerIdentity: "writer-1",
  });
}

function sas(
  itemKey: string,
  permission = "c",
  expiresAtMs = now + 60_000,
): Readonly<{ blobUrl: string; expiresAtMs: number }> {
  const query = new URLSearchParams({
    se: new Date(expiresAtMs).toISOString(),
    sig: "fixture-signature",
    sp: permission,
    spr: "https",
    sr: "b",
    sv: "2026-06-06",
  });
  return Object.freeze({
    blobUrl: `https://blob.example.test/container/${itemKey}?${query.toString()}`,
    expiresAtMs,
  });
}

function credentials(
  mutate?: (
    itemKey: string,
  ) => Readonly<{ blobUrl: string; expiresAtMs: number }>,
): AzureBlobCreateCredentialProvider {
  return {
    createForKey(itemKey) {
      return Promise.resolve(mutate?.(itemKey) ?? sas(itemKey));
    },
  };
}

class FakeSdk implements AzureBlobSdkPort {
  public uploadError: Error | undefined;
  public readonly uploads: Parameters<AzureBlobSdkPort["upload"]>[0][] = [];

  public upload(
    input: Parameters<AzureBlobSdkPort["upload"]>[0],
  ): ReturnType<AzureBlobSdkPort["upload"]> {
    this.uploads.push(input);
    if (this.uploadError !== undefined) return Promise.reject(this.uploadError);
    return Promise.resolve({ contentMd5: md5 });
  }
}

function verifier(
  result: Awaited<
    ReturnType<AzureBlobCreateOnlyVerifier["verifyExact"]>
  > = "match",
): AzureBlobCreateOnlyVerifier {
  return { verifyExact: vi.fn().mockResolvedValue(result) };
}

function client(
  sdk: AzureBlobSdkPort,
  credentialProvider = credentials(),
  exactVerifier = verifier(),
  nowMs: () => number = () => now,
) {
  return createAzureBlobScopedCreateOnlyClient({
    blobUrlForKey: (itemKey) =>
      `https://blob.example.test/container/${itemKey}`,
    credentials: credentialProvider,
    nowMs,
    scope,
    sdk,
    verifier: exactVerifier,
  });
}

function input(itemKey = key) {
  const receipt = authority();
  return Object.freeze({
    authority: receipt,
    bytes,
    checksum,
    key: itemKey,
    reauthorize: () => receipt,
  });
}

describe("Azure Blob scoped create-only client", () => {
  it("creates once using only a create SAS and an opaque verifier", async () => {
    const sdk = new FakeSdk();
    const exactVerifier = verifier();
    const verifyExact = vi.spyOn(exactVerifier, "verifyExact");
    await expect(
      client(sdk, credentials(), exactVerifier).putIfAbsent(input()),
    ).resolves.toEqual({
      checksum,
      created: true,
      key,
      sizeBytes: bytes.byteLength,
    });
    expect(sdk.uploads).toHaveLength(1);
    const firstUpload = sdk.uploads.at(0);
    if (firstUpload === undefined)
      throw new Error("azure_blob_test_upload_missing");
    expect(firstUpload.blobUrl).toContain("sp=c");
    expect(firstUpload.sha256).toBe(checksum);
    expect(Buffer.from(firstUpload.contentMd5)).toEqual(md5);
    expect(verifyExact).toHaveBeenCalledWith({
      checksum,
      contentMd5: md5,
      key,
      sizeBytes: bytes.byteLength,
    });
  });

  it("reconciles an ambiguous create only when the isolated verifier reports an exact match", async () => {
    const sdk = new FakeSdk();
    sdk.uploadError = Object.assign(new Error("denied"), { statusCode: 403 });
    await expect(client(sdk).putIfAbsent(input())).resolves.toMatchObject({
      created: false,
    });
    await expect(
      client(sdk, credentials(), verifier("mismatch")).putIfAbsent(input()),
    ).rejects.toMatchObject({ code: "azure_blob_existing_object_mismatch" });
  });

  it.each([
    ["absent", "azure_blob_create_outcome_ambiguous"],
    ["ambiguous", "azure_blob_create_outcome_ambiguous"],
  ] as const)(
    "fails closed when create is ambiguous and verifier says %s",
    async (result, code) => {
      const sdk = new FakeSdk();
      sdk.uploadError = new Error("timeout");
      await expect(
        client(sdk, credentials(), verifier(result)).putIfAbsent(input()),
      ).rejects.toMatchObject({ code });
    },
  );

  it.each([
    ["../escape", "azure_blob_key_outside_scope"],
    [`${prefix}../escape`, "azure_blob_key_outside_scope"],
    [`${prefix}bad\\name`, "azure_blob_key_outside_scope"],
    [`${prefix}e\u0301`, "azure_blob_key_outside_scope"],
  ])("rejects unsafe key %s", async (itemKey, code) => {
    await expect(
      client(new FakeSdk()).putIfAbsent(input(itemKey)),
    ).rejects.toMatchObject({ code });
  });

  it("rejects stale, write-capable, cross-resource and extended SAS policies before I/O", async () => {
    const cases: readonly (readonly [
      AzureBlobCreateCredentialProvider,
      string,
    ])[] = [
      [
        credentials((itemKey) => sas(itemKey, "c", now - 1)),
        "azure_blob_sas_expiry_invalid",
      ],
      [
        credentials((itemKey) => sas(itemKey, "cw")),
        "azure_blob_sas_policy_invalid",
      ],
      [
        credentials((itemKey) => sas(`other/${itemKey}`)),
        "azure_blob_sas_resource_mismatch",
      ],
      [
        credentials((itemKey) => {
          const value = sas(itemKey);
          return { ...value, blobUrl: `${value.blobUrl}&si=stored-policy` };
        }),
        "azure_blob_sas_policy_invalid",
      ],
      [
        credentials((itemKey) => {
          const value = sas(itemKey);
          return {
            ...value,
            blobUrl: `${value.blobUrl}&st=2026-07-16T11%3A00%3A00Z&st=2026-07-16T11%3A00%3A01Z`,
          };
        }),
        "azure_blob_sas_policy_invalid",
      ],
    ];
    for (const [item, code] of cases) {
      const sdk = new FakeSdk();
      await expect(
        client(sdk, item).putIfAbsent(input()),
      ).rejects.toMatchObject({
        code,
      });
      expect(sdk.uploads).toHaveLength(0);
    }
  });

  it("sanitizes credential issuer errors that contain raw SAS material", async () => {
    const sdk = new FakeSdk();
    const leaking: AzureBlobCreateCredentialProvider = {
      createForKey: () =>
        Promise.reject(
          new Error(
            `https://blob.example.test/?${["sig", "do-not-log"].join("=")}`,
          ),
        ),
    };
    let code = "none";
    try {
      await client(sdk, leaking).putIfAbsent(input());
    } catch (error) {
      code = error instanceof Error ? error.message : "unknown";
    }
    expect(code).toBe("azure_blob_credential_issue_failed");
    expect(sdk.uploads).toHaveLength(0);
  });

  it("rechecks fence freshness after slow credential issuance and before upload", async () => {
    const sdk = new FakeSdk();
    let clock = now;
    const slow: AzureBlobCreateCredentialProvider = {
      createForKey(itemKey) {
        clock = now + 60_001;
        return Promise.resolve(sas(itemKey, "c", now + 120_000));
      },
    };
    await expect(
      client(sdk, slow, verifier(), () => clock).putIfAbsent(input()),
    ).rejects.toMatchObject({ code: "azure_blob_sas_expiry_invalid" });
    expect(sdk.uploads).toHaveLength(0);
  });

  it("rechecks durable authority after credential issuance", async () => {
    const sdk = new FakeSdk();
    const original = input();
    const newerFence = Object.freeze({
      ...fence(),
      expectedDesiredVersion: 2,
      ownerFence: 3,
    });
    const newer = Object.freeze({
      ...authority(),
      durableSequence: 2,
      mutationFence: newerFence,
      mutationFenceFingerprint: fingerprintMutationFence(newerFence),
      operationId: "authority-2",
    });
    await expect(
      client(sdk).putIfAbsent({
        ...original,
        reauthorize: () => newer,
      }),
    ).rejects.toMatchObject({ code: "azure_blob_mutation_authority_invalid" });
    expect(sdk.uploads).toHaveLength(0);
  });

  it("rejects the expiry boundary and a SAS that outlives the mutation fence", async () => {
    const boundarySdk = new FakeSdk();
    await expect(
      client(
        boundarySdk,
        credentials(),
        verifier(),
        () => now + 60_000,
      ).putIfAbsent(input()),
    ).rejects.toMatchObject({ code: "azure_blob_mutation_authority_invalid" });
    expect(boundarySdk.uploads).toHaveLength(0);

    const longSasSdk = new FakeSdk();
    await expect(
      client(
        longSasSdk,
        credentials((itemKey) => sas(itemKey, "c", now + 60_001)),
      ).putIfAbsent(input()),
    ).rejects.toMatchObject({ code: "azure_blob_sas_expiry_invalid" });
    expect(longSasSdk.uploads).toHaveLength(0);
  });

  it("rejects a mutation authority not bound to the allocation and current fence", async () => {
    const sdk = new FakeSdk();
    const bad = {
      ...input(),
      authority: {
        ...authority(),
        mutationFenceFingerprint: `fence-v1-${"0".repeat(64)}`,
      },
    };
    await expect(client(sdk).putIfAbsent(bad)).rejects.toMatchObject({
      code: "azure_blob_mutation_authority_invalid",
    });
    expect(sdk.uploads).toHaveLength(0);
  });
});
