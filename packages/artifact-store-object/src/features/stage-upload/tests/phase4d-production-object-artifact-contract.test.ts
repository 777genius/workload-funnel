import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  scopedUploadAuthorityDigest,
  signPrivilegedSealReceipt,
  type ArtifactStageEntry,
  type ArtifactStageCommand,
  type ScopedUploadIdentity,
} from "@workload-funnel/node-execution/result-staging-reporting";
import {
  createArtifactProviderSet,
  createDurableArtifactMutationAuthority,
  createInMemoryArtifactMutationAuthorityTestFake,
  createInMemoryArtifactMutationAuthorityTestState,
  deleteAndTombstoneResult,
  markRetentionDue,
  prepareArtifactOperation,
  reconcileDeletionAndTombstoneResult,
  stageResultManifest,
  verifyAndFinalizeStagedResult,
} from "@workload-funnel/workload-control/result-management";
import {
  createProvider as createDeleteProvider,
  type ObjectRetentionClient,
} from "../../retention-delete/index.js";
import { createProvider as createVerifyProvider } from "../../verify-finalize/index.js";
import {
  createProvider as createStageProvider,
  openSqliteArtifactMutationAuthorityStore,
  type ObjectStagePutReceipt,
  type ScopedCreateOnlyObjectClient,
} from "../index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true });
});

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fence(
  effect: MutationFence["desiredEffect"],
  scope: string,
  gate = "result_finalize",
): MutationFence {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: effect,
    effectScopeKey: scope,
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    notAfter: 1000,
    notBefore: 0,
    operationGateRevision: 1,
    ownerFence: 2,
    requiredGate: gate,
    schemaVersion: 1,
    supersessionKey: scope,
  });
}

const sealKeys = generateKeyPairSync("ed25519");
const trustedSealReceiptKeys = new Map([
  ["synthetic-seal-receipt-key", sealKeys.publicKey],
]);

function command(): ArtifactStageCommand {
  const entries: readonly ArtifactStageEntry[] = Object.freeze([
    { digest: digest("payload"), path: "nested/result.bin", sizeBytes: 7 },
  ]);
  const uploadIdentity = Object.freeze({
    allocationId: "allocation-1",
    canDelete: false as const,
    canList: false as const,
    canOverwrite: false as const,
    canRead: false as const,
    permissions: Object.freeze(["create"] as const),
    prefix: "allocation-1/generation-1/",
  });
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    entries,
    executionGeneration: "generation-1",
    executionId: "execution-1",
    manifestDigest: digest("manifest"),
    mutationFence: fence("artifact_stage", "artifact-stage:execution-1"),
    operationId: "stage-object-1",
    privilegedSealReceipt: signPrivilegedSealReceipt(
      {
        allocationId: "allocation-1",
        attemptId: "attempt-1",
        authorityRegistrySequence: 7,
        contractVersion: 1,
        entries,
        executionGeneration: "generation-1",
        executionId: "execution-1",
        issuedAt: 0,
        notAfter: 1000,
        providerId: "result-sealer",
        sealId: "seal-1",
        sealMutationFenceFingerprint: `fence-v1-${digest("seal-fence")}`,
        sealOperationId: "seal-operation-1",
        signerKeyId: "synthetic-seal-receipt-key",
        totalBytes: 7,
        treeDigest: digest("tree"),
        uploadAuthorityDigest: scopedUploadAuthorityDigest(uploadIdentity),
      },
      sealKeys.privateKey,
    ),
    sealId: "seal-1",
    treeDigest: digest("tree"),
    uploadIdentity,
  });
}

function artifactAuthority(...fences: readonly MutationFence[]) {
  const authority = createInMemoryArtifactMutationAuthorityTestFake(
    createInMemoryArtifactMutationAuthorityTestState(),
  );
  for (const [index, mutationFence] of fences.entries())
    authority.install({
      mutationFence,
      now: 100,
      operationId: `install-object-authority-${String(index)}`,
      writerIdentity: "synthetic-control-writer",
    });
  return authority;
}

class FakeCreateOnlyClient implements ScopedCreateOnlyObjectClient {
  public readonly capabilities = Object.freeze({
    createOnly: true as const,
    finalMutationFencing: true as const,
    scopedCredentials: true as const,
    serverChecksum: true as const,
  });
  public constructor(
    public readonly scope: ScopedUploadIdentity,
    private readonly objects: Map<
      string,
      Readonly<{ bytes: Buffer; checksum: string }>
    >,
  ) {}
  public putIfAbsent(
    input: Readonly<{
      key: string;
      bytes: Uint8Array;
      checksum: string;
      authority: unknown;
    }>,
  ): Promise<ObjectStagePutReceipt> {
    if (!input.key.startsWith(this.scope.prefix))
      throw new Error("fake_scope_escape");
    const prior = this.objects.get(input.key);
    if (prior !== undefined) {
      if (
        prior.checksum !== input.checksum ||
        !prior.bytes.equals(Buffer.from(input.bytes))
      )
        throw new Error("create_only_conflict");
      return Promise.resolve({
        checksum: prior.checksum,
        created: false,
        key: input.key,
        sizeBytes: prior.bytes.byteLength,
      });
    }
    this.objects.set(input.key, {
      bytes: Buffer.from(input.bytes),
      checksum: input.checksum,
    });
    return Promise.resolve({
      checksum: input.checksum,
      created: true,
      key: input.key,
      sizeBytes: input.bytes.byteLength,
    });
  }
}

describe("Phase 4D production object-store artifact adapter contract", () => {
  it("uses allocation-scoped create-only upload, server verification, and retention identity", async () => {
    const objects = new Map<
      string,
      Readonly<{ bytes: Buffer; checksum: string }>
    >();
    const stageFence = command().mutationFence;
    const deleteFence = fence(
      "artifact_delete",
      "artifact-delete:manifest-1",
      "result_retention",
    );
    const authority = artifactAuthority(stageFence, deleteFence);
    const stage = createStageProvider({
      authority,
      clientFor(identity) {
        return new FakeCreateOnlyClient(identity, objects);
      },
      providerId: "production-object",
      nowMs: () => 100,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("payload"));
        },
      },
      trustedSealReceiptKeys,
    });
    const staged = await stage.stage(command());
    expect(await stage.stage(command())).toEqual(staged);
    expect(objects.size).toBe(1);

    const retention: ObjectRetentionClient = {
      capabilities: Object.freeze({
        finalMutationFencing: true,
        exactResourceDeleteOnly: true,
        retentionCredential: true,
      }),
      deleteExactSetOnce(input) {
        for (const key of [...objects.keys()])
          if (key.startsWith(input.identity)) objects.delete(key);
        return Promise.resolve({
          mutationFence: input.mutationFence,
          mutationFenceFingerprint: fingerprintMutationFence(
            input.mutationFence,
          ),
          operationId: input.operationId,
          providerId: "production-object",
          providerReceiptId: `delete:${input.operationId}`,
          resultManifestId: input.resultManifestId,
          status: "deleted" as const,
        });
      },
      reconcileExactSet(input) {
        const absent = ![...objects.keys()].some((key) =>
          key.startsWith(input.identity),
        );
        return Promise.resolve({
          mutationFence: input.mutationFence,
          mutationFenceFingerprint: fingerprintMutationFence(
            input.mutationFence,
          ),
          operationId: input.operationId,
          providerId: "production-object",
          providerReceiptId: `reconcile:${input.operationId}`,
          resultManifestId: input.resultManifestId,
          status: absent
            ? ("verified_absent" as const)
            : ("still_present" as const),
        });
      },
    };
    const providers = createArtifactProviderSet({
      providers: [
        createVerifyProvider({
          metadata: {
            head(key) {
              const value = objects.get(key);
              return Promise.resolve(
                value === undefined
                  ? undefined
                  : {
                      checksum: value.checksum,
                      sizeBytes: value.bytes.byteLength,
                    },
              );
            },
          },
          nowMs: () => 100,
          providerId: "production-object",
        }),
        createDeleteProvider({
          authority,
          client: retention,
          nowMs: () => 200,
          providerId: "production-object",
        }),
      ],
    });
    const stagedManifest = stageResultManifest({
      artifactProviderId: staged.providerId,
      attemptId: "attempt-1",
      entries: staged.entries,
      executionId: "execution-1",
      immutableStagingIdentity: staged.immutableStagingIdentity,
      manifestDigest: staged.manifestDigest,
      mutationFence: staged.mutationFence,
      mutationFenceFingerprint: staged.mutationFenceFingerprint,
      stagingReceiptBindingDigest: staged.bindingDigest,
      stagingOperationId: staged.operationId,
      resultManifestId: "manifest-1",
      retentionClass: "standard",
      retentionExpiresAt: 1000,
    });
    const finalized = await verifyAndFinalizeStagedResult(providers, {
      manifest: stagedManifest,
      mutationFence: fence("artifact_finalize", "result-finalize:manifest-1"),
      operationId: "verify-object-1",
    });
    expect(finalized.manifest.complete).toBe(true);
    const deleting = prepareArtifactOperation(
      markRetentionDue(finalized.manifest),
      "delete-object-1",
      "delete",
    );
    const deleted = await deleteAndTombstoneResult(providers, {
      manifest: deleting,
      mutationFence: deleteFence,
      tombstone: {
        actorId: "retention-worker",
        deletedAt: 200,
        entryDigests: [digest("payload")],
        policyRevision: 7,
        reason: "expired",
      },
    });
    expect(deleted.manifest).toMatchObject({
      artifactOperation: { state: "applied" },
      retentionState: "deleting",
    });
    const tombstoned = await reconcileDeletionAndTombstoneResult(providers, {
      manifest: deleted.manifest,
      mutationFence: deleteFence,
      tombstone: {
        actorId: "retention-worker",
        deletedAt: 200,
        entryDigests: [digest("payload")],
        policyRevision: 7,
        reason: "expired",
      },
    });
    expect(tombstoned.manifest.retentionState).toBe("tombstoned");
    expect(objects.size).toBe(0);
  });

  it("refuses another allocation scope and keeps ambiguous deletion non-tombstoned", async () => {
    const objects = new Map<
      string,
      Readonly<{ bytes: Buffer; checksum: string }>
    >();
    const stageFence = command().mutationFence;
    const deleteFence = fence(
      "artifact_delete",
      "artifact-delete:manifest-1",
      "result_retention",
    );
    const authority = artifactAuthority(stageFence, deleteFence);
    const stage = createStageProvider({
      authority,
      clientFor(identity) {
        return new FakeCreateOnlyClient(identity, objects);
      },
      providerId: "production-object",
      nowMs: () => 100,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("payload"));
        },
      },
      trustedSealReceiptKeys,
    });
    const original = command();
    await expect(
      stage.stage({
        ...original,
        uploadIdentity: {
          ...original.uploadIdentity,
          prefix: "allocation-2/generation-1/",
        },
      }),
    ).rejects.toThrow("object_stage_fence_mismatch");

    const staged = await stage.stage(original);
    const manifest = prepareArtifactOperation(
      markRetentionDue({
        ...stageResultManifest({
          artifactProviderId: staged.providerId,
          attemptId: "attempt-1",
          entries: staged.entries,
          executionId: "execution-1",
          immutableStagingIdentity: staged.immutableStagingIdentity,
          manifestDigest: staged.manifestDigest,
          mutationFence: staged.mutationFence,
          mutationFenceFingerprint: staged.mutationFenceFingerprint,
          stagingReceiptBindingDigest: staged.bindingDigest,
          stagingOperationId: staged.operationId,
          resultManifestId: "manifest-1",
          retentionClass: "standard",
          retentionExpiresAt: 1000,
        }),
        complete: true,
        publicationState: "complete",
      }),
      "delete-unknown",
      "delete",
    );
    let deleteCalls = 0;
    const providers = createArtifactProviderSet({
      providers: [
        createDeleteProvider({
          authority,
          client: {
            capabilities: Object.freeze({
              finalMutationFencing: true,
              exactResourceDeleteOnly: true,
              retentionCredential: true,
            }),
            deleteExactSetOnce(input) {
              deleteCalls += 1;
              return Promise.resolve({
                mutationFence: input.mutationFence,
                mutationFenceFingerprint: fingerprintMutationFence(
                  input.mutationFence,
                ),
                operationId: input.operationId,
                providerId: "production-object",
                providerReceiptId: `delete:${input.operationId}`,
                resultManifestId: input.resultManifestId,
                status: "unknown" as const,
              });
            },
            reconcileExactSet(input) {
              return Promise.resolve({
                mutationFence: input.mutationFence,
                mutationFenceFingerprint: fingerprintMutationFence(
                  input.mutationFence,
                ),
                operationId: input.operationId,
                providerId: "production-object",
                providerReceiptId: `reconcile:${input.operationId}`,
                resultManifestId: input.resultManifestId,
                status: "still_present" as const,
              });
            },
          },
          nowMs: () => 100,
          providerId: "production-object",
        }),
      ],
    });
    const result = await deleteAndTombstoneResult(providers, {
      manifest,
      mutationFence: deleteFence,
      tombstone: {
        actorId: "retention-worker",
        deletedAt: 200,
        entryDigests: [],
        policyRevision: 1,
        reason: "expired",
      },
    });
    expect(result.manifest).toMatchObject({
      retentionState: "deleting",
      artifactOperation: { state: "unknown" },
    });
    expect(result.manifest.tombstone).toBeUndefined();
    await expect(
      deleteAndTombstoneResult(providers, {
        manifest: result.manifest,
        mutationFence: deleteFence,
        tombstone: {
          actorId: "retention-worker",
          deletedAt: 200,
          entryDigests: [],
          policyRevision: 1,
          reason: "expired",
        },
      }),
    ).rejects.toThrow("result_delete_not_prepared");
    expect(deleteCalls).toBe(1);
    const reconciled = await reconcileDeletionAndTombstoneResult(providers, {
      manifest: result.manifest,
      mutationFence: deleteFence,
      tombstone: {
        actorId: "retention-worker",
        deletedAt: 200,
        entryDigests: [],
        policyRevision: 1,
        reason: "expired",
      },
    });
    expect(reconciled.manifest).toMatchObject({
      artifactOperation: { state: "retryable" },
      retentionState: "deleting",
    });
  });

  it("requires an explicit exact entry set for delete and reconciliation", async () => {
    const stagingFence = command().mutationFence;
    const deleteFence = fence(
      "artifact_delete",
      "artifact-delete:manifest-1",
      "result_retention",
    );
    const durableAuthority = artifactAuthority(deleteFence);
    let authorityCalls = 0;
    let deleteCalls = 0;
    let reconcileCalls = 0;
    const provider = createDeleteProvider({
      authority: {
        authorize(mutationFence, now) {
          authorityCalls += 1;
          return durableAuthority.authorize(mutationFence, now);
        },
        install: (input) => durableAuthority.install(input),
      },
      client: {
        capabilities: Object.freeze({
          exactResourceDeleteOnly: true,
          finalMutationFencing: true,
          retentionCredential: true,
        }),
        deleteExactSetOnce(input) {
          deleteCalls += 1;
          expect(input.expectedEntries).toEqual([]);
          return Promise.resolve({
            mutationFence: input.mutationFence,
            mutationFenceFingerprint: fingerprintMutationFence(
              input.mutationFence,
            ),
            operationId: input.operationId,
            providerId: "production-object",
            providerReceiptId: `delete:${input.operationId}`,
            resultManifestId: input.resultManifestId,
            status: "deleted" as const,
          });
        },
        reconcileExactSet(input) {
          reconcileCalls += 1;
          expect(input.expectedEntries).toEqual([]);
          return Promise.resolve({
            mutationFence: input.mutationFence,
            mutationFenceFingerprint: fingerprintMutationFence(
              input.mutationFence,
            ),
            operationId: input.operationId,
            providerId: "production-object",
            providerReceiptId: `reconcile:${input.operationId}`,
            resultManifestId: input.resultManifestId,
            status: "verified_absent" as const,
          });
        },
      },
      nowMs: () => 100,
      providerId: "production-object",
    });
    if (provider.delete === undefined || provider.reconcileDelete === undefined)
      throw new Error("object_retention_test_provider_incomplete");
    const stagingFingerprint = fingerprintMutationFence(stagingFence);
    const base = Object.freeze({
      entryDigests: Object.freeze([] as string[]),
      immutableStagingIdentity: `${stagingFence.allocationId ?? ""}/${stagingFence.executionGeneration}/${Buffer.from(stagingFingerprint).toString("base64url")}/${digest("manifest")}`,
      mutationFence: deleteFence,
      operationId: "delete-empty-manifest",
      resultManifestId: "manifest-1",
      stagingMutationFence: stagingFence,
      stagingMutationFenceFingerprint: stagingFingerprint,
    });

    await expect(provider.delete(base)).rejects.toThrow(
      "object_delete_entry_binding_mismatch",
    );
    await expect(provider.reconcileDelete(base)).rejects.toThrow(
      "object_delete_entry_binding_mismatch",
    );
    expect({ authorityCalls, deleteCalls, reconcileCalls }).toEqual({
      authorityCalls: 0,
      deleteCalls: 0,
      reconcileCalls: 0,
    });

    const explicitEmpty = Object.freeze({
      ...base,
      expectedEntries: Object.freeze([]),
    });
    await expect(provider.delete(explicitEmpty)).resolves.toMatchObject({
      status: "deleted",
    });
    await expect(
      provider.reconcileDelete(explicitEmpty),
    ).resolves.toMatchObject({ status: "verified_absent" });
    expect({ authorityCalls, deleteCalls, reconcileCalls }).toEqual({
      authorityCalls: 2,
      deleteCalls: 1,
      reconcileCalls: 1,
    });
  });

  it("persists cross-scope authority across restart and makes zero external calls for stale, expired, or substituted seals", async () => {
    const root = mkdtempSync(join(tmpdir(), "wf-artifact-authority-"));
    roots.push(root);
    const path = join(root, "authority.sqlite");
    const stageFence = command().mutationFence;
    let opened = openSqliteArtifactMutationAuthorityStore(path);
    let durableAuthority = createDurableArtifactMutationAuthority(opened.store);
    durableAuthority.install({
      mutationFence: stageFence,
      now: 100,
      operationId: "install-restart-authority",
      writerIdentity: "writer-1",
    });
    durableAuthority.install({
      mutationFence: {
        ...stageFence,
        effectScopeKey: "artifact-stage:execution-newer",
        expectedDesiredVersion: 2,
        namespaceWriterEpoch: 2,
        supersessionKey: "artifact-stage:execution-newer",
      },
      now: 100,
      operationId: "install-newer-cross-scope-authority",
      writerIdentity: "writer-2",
    });
    opened.close();

    opened = openSqliteArtifactMutationAuthorityStore(path);
    durableAuthority = createDurableArtifactMutationAuthority(opened.store);
    let clientCalls = 0;
    let readCalls = 0;
    let putCalls = 0;
    let now = 100;
    const stage = createStageProvider({
      authority: durableAuthority,
      clientFor(identity) {
        clientCalls += 1;
        const client = new FakeCreateOnlyClient(identity, new Map());
        return Object.freeze({
          capabilities: client.capabilities,
          putIfAbsent(input: Parameters<typeof client.putIfAbsent>[0]) {
            putCalls += 1;
            return client.putIfAbsent(input);
          },
          scope: client.scope,
        });
      },
      nowMs: () => now,
      providerId: "production-object",
      sealedReader: {
        read() {
          readCalls += 1;
          return Promise.resolve(Buffer.from("payload"));
        },
      },
      trustedSealReceiptKeys,
    });
    await expect(stage.stage(command())).rejects.toThrow(
      "artifact_cross_scope_high_watermark_rejected",
    );
    expect({ clientCalls, putCalls, readCalls }).toEqual({
      clientCalls: 0,
      putCalls: 0,
      readCalls: 0,
    });
    await expect(
      stage.stage({
        ...command(),
        mutationFence: { ...stageFence, ownerFence: 1 },
      }),
    ).rejects.toThrow("artifact_authority_not_installed");
    expect({ clientCalls, putCalls, readCalls }).toEqual({
      clientCalls: 0,
      putCalls: 0,
      readCalls: 0,
    });

    now = 1000;
    await expect(stage.stage(command())).rejects.toThrow();
    expect({ clientCalls, putCalls, readCalls }).toEqual({
      clientCalls: 0,
      putCalls: 0,
      readCalls: 0,
    });

    now = 100;
    const substitutedUpload = Object.freeze({
      ...command().uploadIdentity,
      allocationId: "allocation-2",
      prefix: "allocation-2/generation-1/",
    });
    await expect(
      stage.stage({
        ...command(),
        allocationId: "allocation-2",
        mutationFence: {
          ...stageFence,
          allocationId: "allocation-2",
        },
        uploadIdentity: substitutedUpload,
      }),
    ).rejects.toThrow("privileged_seal_receipt_invalid");
    expect({ clientCalls, putCalls, readCalls }).toEqual({
      clientCalls: 0,
      putCalls: 0,
      readCalls: 0,
    });
    opened.close();
  });
});
