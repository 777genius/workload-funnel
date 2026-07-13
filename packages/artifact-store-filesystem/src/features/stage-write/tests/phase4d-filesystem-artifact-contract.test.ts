import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { ArtifactStageCommand } from "@workload-funnel/node-execution/result-staging-reporting";
import {
  createArtifactProviderSet,
  deleteAndTombstoneResult,
  markRetentionDue,
  prepareArtifactOperation,
  reconcileDeletionAndTombstoneResult,
  stageResultManifest,
  verifyAndFinalizeStagedResult,
} from "@workload-funnel/workload-control/result-management";
import { createProvider as createDeleteProvider } from "../../retention-delete/index.js";
import {
  UnsafeArtifactPathError,
  createProvider as createVerifyProvider,
} from "../../verify-finalize/index.js";
import { createProvider as createStageProvider } from "../index.js";

const roots: string[] = [];
let nativeHelperPath = "";
let nativeHelperRoot = "";
beforeAll(async () => {
  const buildRoot = await mkdtemp(join(tmpdir(), "wf-artifact-native-helper-"));
  nativeHelperRoot = buildRoot;
  nativeHelperPath = join(buildRoot, "linux-descriptor-fs");
  const compilation = spawnSync(
    "/usr/bin/cc",
    [
      "-std=c17",
      "-DWF_ARTIFACT_STORE_ONLY",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      resolve(process.cwd(), "native/linux-descriptor-fs.c"),
      "-o",
      nativeHelperPath,
    ],
    { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } },
  );
  if (compilation.status !== 0)
    throw new Error(compilation.stderr || "native_test_helper_build_failed");
});
afterAll(async () => rm(nativeHelperRoot, { force: true, recursive: true }));
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  ),
);

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
    ownerFence: 1,
    requiredGate: gate,
    schemaVersion: 1,
    supersessionKey: scope,
  });
}

function stageCommand(path = "result.txt"): ArtifactStageCommand {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    entries: Object.freeze([{ digest: digest("hello"), path, sizeBytes: 5 }]),
    executionGeneration: "generation-1",
    executionId: "execution-1",
    manifestDigest: digest("manifest"),
    mutationFence: fence("artifact_stage", "artifact-stage:execution-1"),
    operationId: "stage-1",
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

describe("Phase 4D local-filesystem artifact adapter contract", () => {
  it("stages create-only bytes, verifies checksums, finalizes, and tombstones after verified deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-phase4d-local-artifacts-"));
    roots.push(root);
    const stage = createStageProvider({
      nativeHelperPath,
      root,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("hello"));
        },
      },
    });
    const staged = await stage.stage(stageCommand());
    expect(await stage.stage(stageCommand())).toEqual(staged);

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
    expect(stagedManifest).toMatchObject({
      stagingMutationFence: staged.mutationFence,
      stagingMutationFenceFingerprint: staged.mutationFenceFingerprint,
      stagingReceiptBindingDigest: staged.bindingDigest,
      stagingOperationId: staged.operationId,
    });
    const providers = createArtifactProviderSet({
      providers: [
        createVerifyProvider({ nativeHelperPath, nowMs: () => 100, root }),
        createDeleteProvider({ nowMs: () => 200, root }),
      ],
    });
    const finalized = await verifyAndFinalizeStagedResult(providers, {
      manifest: stagedManifest,
      mutationFence: fence("artifact_finalize", "result-finalize:manifest-1"),
      operationId: "verify-1",
    });
    expect(finalized.manifest).toMatchObject({
      complete: true,
      publicationState: "complete",
    });

    const deleting = prepareArtifactOperation(
      markRetentionDue(finalized.manifest),
      "delete-1",
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
        entryDigests: [digest("hello")],
        policyRevision: 4,
        reason: "retention_expired",
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
        entryDigests: [digest("hello")],
        policyRevision: 4,
        reason: "retention_expired",
      },
    });
    expect(tombstoned.manifest).toMatchObject({ retentionState: "tombstoned" });
  });

  it("refuses malicious paths and cross-allocation upload identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-phase4d-local-artifacts-"));
    roots.push(root);
    const stage = createStageProvider({
      nativeHelperPath,
      root,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("hello"));
        },
      },
    });
    await expect(stage.stage(stageCommand("../escape"))).rejects.toThrow(
      "unsafe_artifact_entry_path",
    );
    const command = stageCommand();
    await expect(
      stage.stage({
        ...command,
        uploadIdentity: {
          ...command.uploadIdentity,
          allocationId: "allocation-2",
        },
      }),
    ).rejects.toThrow("filesystem_stage_fence_mismatch");
  });

  it("refuses a destination symlink and never replaces an existing staging identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-phase4d-local-artifacts-"));
    roots.push(root);
    const command = stageCommand();
    const identity = `local-v2:${Buffer.from(command.allocationId).toString("base64url")}:${Buffer.from(command.executionGeneration).toString("base64url")}:${Buffer.from(fingerprintMutationFence(command.mutationFence)).toString("base64url")}:${command.manifestDigest}`;
    const finalName = createHash("sha256").update(identity).digest("hex");
    const outside = await mkdtemp(join(tmpdir(), "wf-phase4d-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, finalName));
    const stage = createStageProvider({
      nativeHelperPath,
      root,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("hello"));
        },
      },
    });
    await expect(stage.stage(command)).rejects.toThrow(
      "native_artifact_boundary_refused",
    );
    await expect(readFile(join(outside, "result.txt"))).rejects.toThrow();
  });

  it("detects post-stage byte mutation through descriptor-relative finalization", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-phase4d-local-artifacts-"));
    roots.push(root);
    const stage = createStageProvider({
      nativeHelperPath,
      root,
      sealedReader: {
        read() {
          return Promise.resolve(Buffer.from("hello"));
        },
      },
    });
    const staged = await stage.stage(stageCommand());
    const finalName = createHash("sha256")
      .update(staged.immutableStagingIdentity)
      .digest("hex");
    const target = join(root, finalName, "result.txt");
    await chmod(target, 0o600);
    await writeFile(target, "evil!");
    const manifest = stageResultManifest({
      attemptId: "attempt-1",
      entries: staged.entries,
      executionId: "execution-1",
      immutableStagingIdentity: staged.immutableStagingIdentity,
      manifestDigest: staged.manifestDigest,
      mutationFence: staged.mutationFence,
      mutationFenceFingerprint: staged.mutationFenceFingerprint,
      resultManifestId: "manifest-1",
      retentionClass: "standard",
      retentionExpiresAt: 1000,
      stagingReceiptBindingDigest: staged.bindingDigest,
      stagingOperationId: staged.operationId,
    });
    await expect(
      verifyAndFinalizeStagedResult(
        createArtifactProviderSet({
          providers: [createVerifyProvider({ nativeHelperPath, root })],
        }),
        {
          manifest,
          mutationFence: fence(
            "artifact_finalize",
            "result-finalize:manifest-1",
          ),
          operationId: "verify-mutated",
        },
      ),
    ).rejects.toThrow(UnsafeArtifactPathError);
  });
});
