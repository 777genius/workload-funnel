import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import {
  createInMemoryArtifactMutationAuthorityTestFake,
  createInMemoryArtifactMutationAuthorityTestState,
  createArtifactProviderSet,
  resultStagingReceiptBinding,
  stageResultManifest,
  verifyAndFinalizeStagedResult,
  type ArtifactProvider,
  type ArtifactVerificationCommand,
  type ResultEntry,
} from "../index.js";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fence(
  effect: MutationFence["desiredEffect"],
  scope: string,
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
    ownerFence: 1,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: scope,
  });
}

function manifest(providerId: string, location: string) {
  const mutationFence = fence("artifact_stage", "artifact-stage:execution-1");
  const mutationFenceFingerprint = fingerprintMutationFence(mutationFence);
  const entries: readonly ResultEntry[] = Object.freeze([
    {
      checksum: digest("payload"),
      location,
      path: "result.bin",
      sizeBytes: 7,
    },
  ]);
  const evidence = {
    artifactProviderId: providerId,
    attemptId: "attempt-1",
    entries,
    executionId: "execution-1",
    immutableStagingIdentity: `allocation-1/generation-1/${Buffer.from(mutationFenceFingerprint).toString("base64url")}/${digest("manifest")}`,
    manifestDigest: digest("manifest"),
    mutationFence,
    mutationFenceFingerprint,
    resultManifestId: `manifest-${providerId}`,
    retentionClass: "standard" as const,
    retentionExpiresAt: 1000,
    stagingOperationId: `stage-${providerId}`,
  };
  return stageResultManifest({
    ...evidence,
    stagingReceiptBindingDigest: resultStagingReceiptBinding(evidence),
  });
}

function verifier(providerId: string, calls: string[]): ArtifactProvider {
  return Object.freeze({
    capabilities: Object.freeze(["verify_finalized_bytes"] as const),
    providerId,
    verify(command: ArtifactVerificationCommand) {
      calls.push(`${providerId}:${command.resultManifestId}`);
      return Promise.resolve(
        Object.freeze({
          immutableStagingIdentity: command.immutableStagingIdentity,
          manifestDigest: command.manifestDigest,
          operationId: command.operationId,
          providerId,
          resultManifestId: command.resultManifestId,
          status: "verified" as const,
          verifiedAtMs: 100,
          verifiedEntries: command.expectedEntries,
        }),
      );
    },
  });
}

describe("Phase 8 local/object artifact replacement contract", () => {
  it("cordons an unrecovered final mutator and rejects stale or equal-mismatched cross-scope owners", () => {
    const installed = Object.freeze({
      ...fence("artifact_stage", "artifact-stage:execution-1"),
      ownerFence: 2,
    });
    const state = createInMemoryArtifactMutationAuthorityTestState();
    const authority = createInMemoryArtifactMutationAuthorityTestFake(state);
    authority.install({
      mutationFence: installed,
      now: 100,
      operationId: "install-artifact-authority-1",
      writerIdentity: "control-writer-2",
    });
    expect(() =>
      authority.install({
        mutationFence: {
          ...installed,
          effectScopeKey: "artifact-stage:execution-2",
          ownerFence: 1,
          supersessionKey: "artifact-stage:execution-2",
        },
        now: 100,
        operationId: "install-artifact-authority-stale",
        writerIdentity: "control-writer-2",
      }),
    ).toThrow("artifact_authority_stale");
    expect(() =>
      authority.install({
        mutationFence: installed,
        now: 100,
        operationId: "install-artifact-authority-writer-mismatch",
        writerIdentity: "control-writer-equal-mismatch",
      }),
    ).toThrow("artifact_authority_equal_version_mismatch");
    expect(() =>
      authority.install({
        mutationFence: {
          ...installed,
          attemptId: "attempt-equal-version-mismatch",
          effectScopeKey: "artifact-stage:execution-2",
          supersessionKey: "artifact-stage:execution-2",
        },
        now: 100,
        operationId: "install-artifact-authority-mismatch",
        writerIdentity: "control-writer-2",
      }),
    ).toThrow("artifact_authority_equal_version_mismatch");
    const unrecovered = createInMemoryArtifactMutationAuthorityTestFake({
      ...createInMemoryArtifactMutationAuthorityTestState(),
      recovered: false,
    });
    expect(() => unrecovered.authorize(installed, 100)).toThrow(
      "artifact_authority_cordoned",
    );
  });

  it("selects the immutable staged provider when local and object adapters coexist", async () => {
    const calls: string[] = [];
    const providers = createArtifactProviderSet({
      providers: [
        verifier("local-filesystem", calls),
        verifier("production-object", calls),
      ],
    });
    const finalizeFence = fence(
      "artifact_finalize",
      "result-finalize:manifest-local-filesystem",
    );
    const local = await verifyAndFinalizeStagedResult(providers, {
      manifest: manifest("local-filesystem", "file+wf://local/result"),
      mutationFence: finalizeFence,
      operationId: "verify-local",
    });
    expect(local.verification.providerId).toBe("local-filesystem");
    const object = await verifyAndFinalizeStagedResult(providers, {
      manifest: manifest("production-object", "object+wf://bucket/result"),
      mutationFence: {
        ...finalizeFence,
        effectScopeKey: "result-finalize:manifest-production-object",
        supersessionKey: "result-finalize:manifest-production-object",
      },
      operationId: "verify-object",
    });
    expect(object.verification.providerId).toBe("production-object");
    expect(calls).toEqual([
      "local-filesystem:manifest-local-filesystem",
      "production-object:manifest-production-object",
    ]);
  });

  it("fails closed instead of replacing a missing staged provider", async () => {
    const providers = createArtifactProviderSet({
      providers: [verifier("production-object", [])],
    });
    await expect(
      verifyAndFinalizeStagedResult(providers, {
        manifest: manifest("local-filesystem", "file+wf://local/result"),
        mutationFence: fence(
          "artifact_finalize",
          "result-finalize:manifest-local-filesystem",
        ),
        operationId: "verify-missing-local",
      }),
    ).rejects.toThrow("unschedulable_missing_capability");
  });
});
