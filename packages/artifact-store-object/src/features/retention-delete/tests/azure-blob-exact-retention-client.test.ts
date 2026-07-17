import { describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { ArtifactMutationAuthorityReceipt } from "@workload-funnel/workload-control/result-management";
import {
  objectArtifactKey,
  objectArtifactLocation,
} from "@workload-funnel/artifact-store-object/stage-upload";
import {
  createAzureBlobExactRetentionClient,
  type AzureBlobRetentionSdkPort,
} from "../azure-blob-exact-retention-client.js";
import type { ObjectRetentionMutation } from "../index.js";

const now = Date.parse("2026-07-16T12:00:00.000Z");
const providerId = "azure-blob-storage";
const identity = `allocation-1/generation-1/${"a".repeat(64)}/${"b".repeat(64)}`;

function fence(): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "artifact_delete",
    effectScopeKey: "artifact-delete:manifest-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    notAfter: now + 60_000,
    notBefore: now - 60_000,
    operationGateRevision: 1,
    ownerFence: 2,
    requiredGate: "result_retention",
    schemaVersion: 1,
    supersessionKey: "artifact-delete:manifest-1",
  });
}

function authority(mutationFence = fence()): ArtifactMutationAuthorityReceipt {
  return Object.freeze({
    durableSequence: 1,
    effectScopeKey: mutationFence.effectScopeKey,
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    operationId: "authority-1",
    writerIdentity: "retention-worker",
  });
}

function sas(key: string, permission: "d" | "r", expiresAtMs = now + 60_000) {
  const query = new URLSearchParams({
    se: new Date(expiresAtMs).toISOString(),
    sig: "fixture-signature",
    sp: permission,
    spr: "https",
    sr: "b",
    sv: "2026-06-06",
  });
  return Object.freeze({
    blobUrl: `https://blob.example.test/container/${key}?${query.toString()}`,
    expiresAtMs,
  });
}

function entry(path: string, checksum = "c".repeat(64), sizeBytes = 7) {
  const key = objectArtifactKey(identity, path);
  return Object.freeze({
    checksum,
    key,
    result: Object.freeze({
      checksum,
      location: objectArtifactLocation(providerId, key),
      path,
      sizeBytes,
    }),
  });
}

function mutation(
  entries = [entry("artifact.bin")],
  reauthorize?: () => ArtifactMutationAuthorityReceipt,
): ObjectRetentionMutation {
  const mutationFence = fence();
  const installedAuthority = authority(mutationFence);
  return Object.freeze({
    authority: installedAuthority,
    expectedEntries: Object.freeze(entries.map((item) => item.result)),
    identity,
    mutationFence,
    operationId: "delete-operation-1",
    reauthorize: reauthorize ?? (() => installedAuthority),
    resultManifestId: "manifest-1",
  });
}

class FakeSdk implements AzureBlobRetentionSdkPort {
  public readonly states = new Map<
    string,
    { checksum: string; etag: string; sizeBytes: number }
  >();
  public failDeleteKey: string | undefined;
  public readonly deletes: string[] = [];
  public readonly propertyReads: string[] = [];

  private key(blobUrl: string): string {
    return new URL(blobUrl).pathname.slice("/container/".length);
  }

  public delete(
    input: Parameters<AzureBlobRetentionSdkPort["delete"]>[0],
  ): Promise<void> {
    const key = this.key(input.blobUrl);
    this.deletes.push(key);
    if (key === this.failDeleteKey)
      return Promise.reject(
        Object.assign(new Error("raw"), { statusCode: 500 }),
      );
    const state = this.states.get(key);
    if (state === undefined)
      return Promise.reject(
        Object.assign(new Error("absent"), { statusCode: 404 }),
      );
    if (state.etag !== input.etag)
      return Promise.reject(
        Object.assign(new Error("changed"), { statusCode: 412 }),
      );
    this.states.delete(key);
    return Promise.resolve();
  }

  public properties(
    input: Parameters<AzureBlobRetentionSdkPort["properties"]>[0],
  ): ReturnType<AzureBlobRetentionSdkPort["properties"]> {
    const key = this.key(input.blobUrl);
    this.propertyReads.push(key);
    const state = this.states.get(key);
    if (state === undefined)
      return Promise.reject(
        Object.assign(new Error("absent"), { statusCode: 404 }),
      );
    return Promise.resolve({
      contentLength: state.sizeBytes,
      etag: state.etag,
      metadata: { wfsha256: state.checksum },
    });
  }
}

function client(sdk: FakeSdk, nowMs: () => number = () => now) {
  return createAzureBlobExactRetentionClient({
    blobUrlForKey: (key) => `https://blob.example.test/container/${key}`,
    deleteCredentials: {
      deleteForKey: (key) => Promise.resolve(sas(key, "d")),
    },
    nowMs,
    providerId,
    readCredentials: {
      readForKey: (key) => Promise.resolve(sas(key, "r")),
    },
    sdk,
  });
}

function seed(sdk: FakeSdk, items: readonly ReturnType<typeof entry>[]) {
  for (const item of items)
    sdk.states.set(item.key, {
      checksum: item.checksum,
      etag: `etag-${item.result.path}`,
      sizeBytes: item.result.sizeBytes,
    });
}

describe("Azure Blob exact-set retention client", () => {
  it("deletes an exact blob set idempotently and verifies absence", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    const command = mutation([item]);
    const first = await client(sdk).deleteExactSetOnce(command);
    expect(first).toMatchObject({
      status: "deleted",
    });
    await expect(client(sdk).reconcileExactSet(command)).resolves.toMatchObject(
      {
        status: "verified_absent",
      },
    );
    await expect(client(sdk).deleteExactSetOnce(command)).resolves.toEqual(
      first,
    );
  });

  it("returns unknown after a partial provider failure and safely resumes", async () => {
    const sdk = new FakeSdk();
    const items = [entry("a.bin"), entry("b.bin")];
    const ordered = [...items].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    seed(sdk, items);
    sdk.failDeleteKey = ordered[1]?.key;
    const command = mutation(items);
    await expect(
      client(sdk).deleteExactSetOnce(command),
    ).resolves.toMatchObject({
      status: "unknown",
    });
    expect(sdk.states.has(ordered[0]?.key ?? "")).toBe(false);
    expect(sdk.states.has(ordered[1]?.key ?? "")).toBe(true);
    sdk.failDeleteKey = undefined;
    await expect(
      client(sdk).deleteExactSetOnce(command),
    ).resolves.toMatchObject({
      status: "deleted",
    });
    await expect(client(sdk).reconcileExactSet(command)).resolves.toMatchObject(
      {
        status: "verified_absent",
      },
    );
  });

  it("returns unknown immediately after the first ambiguous mutation", async () => {
    const sdk = new FakeSdk();
    const items = [entry("a.bin"), entry("b.bin")];
    const ordered = [...items].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
    seed(sdk, items);
    sdk.failDeleteKey = ordered[0]?.key;
    const second = sdk.states.get(ordered[1]?.key ?? "");
    if (second === undefined) throw new Error("retention_test_state_missing");
    second.checksum = "d".repeat(64);

    await expect(
      client(sdk).deleteExactSetOnce(mutation(items)),
    ).resolves.toMatchObject({ status: "unknown" });
    expect(sdk.deletes).toEqual([ordered[0]?.key]);
    expect(sdk.propertyReads).toEqual([ordered[0]?.key]);
    expect(sdk.states.has(ordered[1]?.key ?? "")).toBe(true);
  });

  it("binds deterministic receipts to the canonical exact entry set", async () => {
    const sdk = new FakeSdk();
    const forward = [entry("a.bin"), entry("b.bin")];
    const reverse = [...forward].reverse();
    const first = await client(sdk).reconcileExactSet(mutation(forward));
    const reordered = await client(sdk).reconcileExactSet(mutation(reverse));
    expect(reordered).toEqual(first);

    const changed = [
      entry("a.bin", "d".repeat(64), 8),
      entry("b.bin", "e".repeat(64), 9),
    ];
    const rebound = await client(sdk).reconcileExactSet(mutation(changed));
    expect(rebound.providerReceiptId).not.toBe(first.providerReceiptId);
  });

  it("fails closed on replacement or a foreign location before delete", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    const state = sdk.states.get(item.key);
    if (state === undefined) throw new Error("retention_test_state_missing");
    state.checksum = "d".repeat(64);
    await expect(
      client(sdk).deleteExactSetOnce(mutation([item])),
    ).rejects.toMatchObject({
      code: "azure_blob_retention_object_replaced",
    });
    const foreign = {
      ...item,
      result: {
        ...item.result,
        location: objectArtifactLocation(providerId, "foreign/allocation.bin"),
      },
    };
    await expect(
      client(sdk).deleteExactSetOnce(mutation([foreign])),
    ).rejects.toMatchObject({
      code: "azure_blob_retention_location_mismatch",
    });
    expect(sdk.deletes).toHaveLength(0);
  });

  it("rechecks fence freshness after slow delete credential issuance", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    let clock = now;
    const retention = createAzureBlobExactRetentionClient({
      blobUrlForKey: (key) => `https://blob.example.test/container/${key}`,
      deleteCredentials: {
        deleteForKey(key) {
          clock = now + 60_001;
          return Promise.resolve(sas(key, "d", now + 120_000));
        },
      },
      nowMs: () => clock,
      providerId,
      readCredentials: {
        readForKey: (key) => Promise.resolve(sas(key, "r")),
      },
      sdk,
    });
    await expect(
      retention.deleteExactSetOnce(mutation([item])),
    ).rejects.toMatchObject({
      code: "azure_blob_retention_credential_outlives_authority",
    });
    expect(sdk.deletes).toHaveLength(0);
  });

  it("rechecks durable authority after delete credential issuance", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    let superseded = false;
    const retention = createAzureBlobExactRetentionClient({
      blobUrlForKey: (key) => `https://blob.example.test/container/${key}`,
      deleteCredentials: {
        deleteForKey(key) {
          superseded = true;
          return Promise.resolve(sas(key, "d"));
        },
      },
      nowMs: () => now,
      providerId,
      readCredentials: {
        readForKey: (key) => Promise.resolve(sas(key, "r")),
      },
      sdk,
    });
    const command = mutation([item], () => {
      if (superseded) throw new Error("authority superseded");
      return authority(fence());
    });
    await expect(retention.deleteExactSetOnce(command)).rejects.toMatchObject({
      code: "azure_blob_retention_authority_invalid",
    });
    expect(sdk.deletes).toHaveLength(0);
  });

  it("requires the durable authority receipt to remain exactly installed", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    const installed = authority(fence());
    const command = Object.freeze({
      ...mutation([item]),
      authority: installed,
      reauthorize: () => Object.freeze({ ...installed, durableSequence: 2 }),
    });
    await expect(client(sdk).deleteExactSetOnce(command)).rejects.toMatchObject(
      { code: "azure_blob_retention_authority_invalid" },
    );
    expect(sdk.deletes).toHaveLength(0);
  });

  it("rejects the exact authority deadline before delete", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    let calls = 0;
    const clock = () => (++calls >= 4 ? now + 60_000 : now);
    await expect(
      client(sdk, clock).deleteExactSetOnce(mutation([item])),
    ).rejects.toMatchObject({ code: "azure_blob_retention_authority_invalid" });
    expect(sdk.deletes).toHaveLength(0);
  });

  it("rejects the actual SAS expiry when it outlives authority", async () => {
    const sdk = new FakeSdk();
    const item = entry("artifact.bin");
    seed(sdk, [item]);
    const retention = createAzureBlobExactRetentionClient({
      blobUrlForKey: (key) => `https://blob.example.test/container/${key}`,
      deleteCredentials: {
        deleteForKey(key) {
          const issued = sas(key, "d");
          const blobUrl = new URL(issued.blobUrl);
          blobUrl.searchParams.set("se", new Date(now + 60_001).toISOString());
          return Promise.resolve({
            ...issued,
            blobUrl: blobUrl.toString(),
          });
        },
      },
      nowMs: () => now,
      providerId,
      readCredentials: {
        readForKey: (key) => Promise.resolve(sas(key, "r")),
      },
      sdk,
    });
    await expect(
      retention.deleteExactSetOnce(mutation([item])),
    ).rejects.toMatchObject({
      code: "azure_blob_retention_credential_outlives_authority",
    });
    expect(sdk.deletes).toHaveLength(0);
  });
});
