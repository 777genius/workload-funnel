import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  ArtifactStageCommand,
  ScopedUploadIdentity,
} from "@workload-funnel/node-execution/result-staging-reporting";
import {
  createArtifactProviderSet,
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
  type ObjectStagePutReceipt,
  type ScopedCreateOnlyObjectClient,
} from "../index.js";

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
    operationGateRevision: 1,
    ownerFence: 2,
    requiredGate: gate,
    schemaVersion: 1,
    supersessionKey: scope,
  });
}

function command(): ArtifactStageCommand {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    entries: Object.freeze([
      { digest: digest("payload"), path: "nested/result.bin", sizeBytes: 7 },
    ]),
    executionGeneration: "generation-1",
    executionId: "execution-1",
    manifestDigest: digest("manifest"),
    mutationFence: fence("artifact_stage", "artifact-stage:execution-1"),
    operationId: "stage-object-1",
    sealId: "seal-1",
    treeDigest: digest("tree"),
    uploadIdentity: Object.freeze({
      allocationId: "allocation-1",
      canDelete: false,
      canList: false,
      canOverwrite: false,
      canRead: false,
      permissions: Object.freeze(["create"] as const),
      prefix: "allocation-1/generation-1/",
    }),
  });
}

class FakeCreateOnlyClient implements ScopedCreateOnlyObjectClient {
  public constructor(
    public readonly scope: ScopedUploadIdentity,
    private readonly objects: Map<
      string,
      Readonly<{ bytes: Buffer; checksum: string }>
    >,
  ) {}
  public putIfAbsent(
    input: Readonly<{ key: string; bytes: Uint8Array; checksum: string }>,
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
    const stage = createStageProvider({
      clientFor(identity) {
        return new FakeCreateOnlyClient(identity, objects);
      },
      providerId: "production-object",
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("payload"));
        },
      },
    });
    const staged = await stage.stage(command());
    expect(await stage.stage(command())).toEqual(staged);
    expect(objects.size).toBe(1);

    const retention: ObjectRetentionClient = {
      deletePrefixOnce(input) {
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
      reconcilePrefix(input) {
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
          client: retention,
          nowMs: () => 200,
          providerId: "production-object",
        }),
      ],
    });
    const stagedManifest = stageResultManifest({
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
      mutationFence: fence(
        "artifact_delete",
        "artifact-delete:manifest-1",
        "result_retention",
      ),
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
      mutationFence: fence(
        "artifact_delete",
        "artifact-delete:manifest-1",
        "result_retention",
      ),
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
    const stage = createStageProvider({
      clientFor(identity) {
        return new FakeCreateOnlyClient(identity, objects);
      },
      providerId: "production-object",
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("payload"));
        },
      },
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
          client: {
            deletePrefixOnce(input) {
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
            reconcilePrefix(input) {
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
          providerId: "production-object",
        }),
      ],
    });
    const result = await deleteAndTombstoneResult(providers, {
      manifest,
      mutationFence: fence(
        "artifact_delete",
        "artifact-delete:manifest-1",
        "result_retention",
      ),
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
        mutationFence: fence(
          "artifact_delete",
          "artifact-delete:manifest-1",
          "result_retention",
        ),
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
      mutationFence: fence(
        "artifact_delete",
        "artifact-delete:manifest-1",
        "result_retention",
      ),
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
});
