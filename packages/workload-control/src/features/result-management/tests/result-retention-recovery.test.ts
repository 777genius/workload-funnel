import { describe, expect, it } from "vitest";

import {
  InvalidRetentionTransitionError,
  decideResultCompletion,
  markArtifactOperationUnknown,
  markRetentionDue,
  prepareArtifactOperation,
  reconcileArtifactOperation,
  tombstoneResult,
  type ResultManifest,
} from "../index.js";

function manifest(entries: ResultManifest["entries"] = []): ResultManifest {
  return Object.freeze({
    attemptId: "attempt-1",
    complete: true,
    entries: Object.freeze(entries),
    executionId: "execution-1",
    resultManifestId: "manifest-1",
    retentionClass: "synthetic-ephemeral",
    retentionState: "active",
    version: 1,
  });
}

describe("Phase 2 result process manager and retention", () => {
  it("treats an explicit empty manifest as complete", () => {
    expect(decideResultCompletion(manifest(), [])).toMatchObject({
      reason: "complete",
      terminalCandidate: "succeeded",
    });
  });

  it("emits publication failure when required outputs are missing", () => {
    expect(decideResultCompletion(manifest(), ["required.json"])).toMatchObject(
      {
        reason: "required_output_missing",
        terminalCandidate: "publication_failure",
      },
    );
  });

  it("keeps ambiguous artifact delete prepared under its stable identity", () => {
    const due = markRetentionDue(manifest());
    const prepared = prepareArtifactOperation(due, "delete-1", "delete");
    const unknown = markArtifactOperationUnknown(prepared);
    expect(unknown).toMatchObject({
      artifactOperation: {
        operationId: "delete-1",
        stagingIdentity: "artifact-operation:manifest-1:delete-1",
        state: "unknown",
      },
      retentionState: "deleting",
    });
    expect(prepareArtifactOperation(unknown, "delete-1", "delete")).toBe(
      unknown,
    );
    expect(() =>
      prepareArtifactOperation(unknown, "delete-2", "delete"),
    ).toThrow("artifact_operation_conflict");
  });

  it("requires verified deletion before a durable tombstone", () => {
    const prepared = prepareArtifactOperation(
      markRetentionDue(manifest()),
      "delete-1",
      "delete",
    );
    expect(() =>
      tombstoneResult(prepared, {
        actorId: "retention-worker",
        deletedAt: 100,
        entryDigests: [],
        policyRevision: 2,
        reason: "retention_expired",
      }),
    ).toThrow(InvalidRetentionTransitionError);
    const verified = reconcileArtifactOperation(
      markArtifactOperationUnknown(prepared),
      "applied",
    );
    const tombstone = tombstoneResult(verified, {
      actorId: "retention-worker",
      deletedAt: 100,
      entryDigests: ["checksum-1"],
      policyRevision: 2,
      reason: "retention_expired",
    });
    expect(tombstone).toMatchObject({
      retentionState: "tombstoned",
      tombstone: {
        deletedAt: 100,
        entryDigests: ["checksum-1"],
      },
    });
  });
});
