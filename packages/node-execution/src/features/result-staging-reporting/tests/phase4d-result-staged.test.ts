import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import {
  DurableObservationSpool,
  type ObservationSpoolStorage,
} from "@workload-funnel/node-execution/observation-spooling";
import {
  artifactStageReceiptBinding,
  createProvider,
  type ArtifactStageCommand,
  type ArtifactStageWriter,
} from "../index.js";

class MemorySpool implements ObservationSpoolStorage {
  public readonly capacity = 10;
  readonly lines: string[] = [];
  public appendAndSync(value: string): void {
    this.lines.push(value);
  }
  public readAll(): readonly string[] {
    return this.lines;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function command(): ArtifactStageCommand {
  const mutationFence: MutationFence = Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "artifact_stage",
    effectScopeKey: "artifact-stage:execution-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 4,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    operationGateRevision: 1,
    ownerFence: 3,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: "artifact-stage:execution-1",
  });
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    entries: Object.freeze([
      { digest: digest("hello"), path: "result.txt", sizeBytes: 5 },
    ]),
    executionGeneration: "generation-1",
    executionId: "execution-1",
    manifestDigest: digest("manifest"),
    mutationFence,
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

describe("Phase 4D fenced ResultStaged reporting", () => {
  it("spools a complete-fence ResultStaged observation only after immutable staging", async () => {
    let calls = 0;
    const writer: ArtifactStageWriter = Object.freeze({
      capability: "create_only_scoped_stage",
      providerId: "synthetic-artifact",
      stage(input: ArtifactStageCommand) {
        calls += 1;
        const receiptFields = Object.freeze({
          entries: Object.freeze(
            input.entries.map((entry) =>
              Object.freeze({
                checksum: entry.digest,
                location: `synthetic://${entry.path}`,
                path: entry.path,
                sizeBytes: entry.sizeBytes,
              }),
            ),
          ),
          immutableStagingIdentity: `allocation-1/generation-1/${Buffer.from(fingerprintMutationFence(input.mutationFence)).toString("base64url")}/manifest`,
          manifestDigest: input.manifestDigest,
          mutationFenceFingerprint: fingerprintMutationFence(
            input.mutationFence,
          ),
          operationId: input.operationId,
          providerId: "synthetic-artifact",
        });
        return Promise.resolve(
          Object.freeze({
            ...receiptFields,
            bindingDigest: artifactStageReceiptBinding(receiptFields),
            mutationFence: input.mutationFence,
            state: "staged",
          }),
        );
      },
    });
    const spool = new DurableObservationSpool(new MemorySpool());
    const reporter = createProvider({
      artifactStageWriter: writer,
      nodeBootEpoch: 8,
      nodeId: "node-1",
      nowMs: () => 100,
      observationSpool: spool,
    });
    const observation = await reporter.stageAndReport(command());
    expect(observation).toMatchObject({
      kind: "ResultStaged",
      operationId: "stage-1",
      observedAtMs: 100,
    });
    expect(observation.mutationFenceFingerprint).toMatch(
      /^fence-v1-[a-f0-9]{64}$/u,
    );
    expect(spool.pending).toHaveLength(1);
    expect(spool.pending[0]).toMatchObject({
      kind: "result_staged",
      sourceSequence: 4,
    });
    expect(calls).toBe(1);
  });

  it("rejects cross-allocation identity before invoking the artifact writer", async () => {
    let called = false;
    const writer: ArtifactStageWriter = {
      capability: "create_only_scoped_stage",
      providerId: "synthetic-artifact",
      stage() {
        called = true;
        return Promise.reject(new Error("must not run"));
      },
    };
    const reporter = createProvider({
      artifactStageWriter: writer,
      nodeBootEpoch: 8,
      nodeId: "node-1",
      observationSpool: new DurableObservationSpool(new MemorySpool()),
    });
    const original = command();
    await expect(
      reporter.stageAndReport({
        ...original,
        uploadIdentity: {
          ...original.uploadIdentity,
          allocationId: "allocation-2",
        },
      }),
    ).rejects.toThrow("artifact_stage_authority_mismatch");
    expect(called).toBe(false);
  });

  it("rejects a receipt whose locations or entries are not bound to its complete fence", async () => {
    const original = command();
    const mutationFenceFingerprint = fingerprintMutationFence(
      original.mutationFence,
    );
    const receiptFields = {
      entries: Object.freeze([
        {
          checksum: original.entries[0]?.digest ?? "",
          location: "synthetic://approved/result.txt",
          path: "result.txt",
          sizeBytes: 5,
        },
      ]),
      immutableStagingIdentity: `allocation-1/generation-1/${Buffer.from(mutationFenceFingerprint).toString("base64url")}/manifest`,
      manifestDigest: original.manifestDigest,
      mutationFenceFingerprint,
      operationId: original.operationId,
      providerId: "synthetic-artifact",
    };
    const approvedEntry = receiptFields.entries[0];
    if (approvedEntry === undefined) throw new Error("missing_test_entry");
    const spool = new DurableObservationSpool(new MemorySpool());
    const reporter = createProvider({
      artifactStageWriter: {
        capability: "create_only_scoped_stage",
        providerId: "synthetic-artifact",
        stage() {
          return Promise.resolve({
            ...receiptFields,
            bindingDigest: artifactStageReceiptBinding(receiptFields),
            entries: Object.freeze([
              { ...approvedEntry, location: "synthetic://attacker" },
            ]),
            mutationFence: original.mutationFence,
            state: "staged",
          });
        },
      },
      nodeBootEpoch: 8,
      nodeId: "node-1",
      observationSpool: spool,
    });
    await expect(reporter.stageAndReport(original)).rejects.toThrow(
      "artifact_stage_receipt_mismatch",
    );
    expect(spool.pending).toHaveLength(0);
  });
});
