import { createHash } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { DurableObservationSpool } from "@workload-funnel/node-execution/observation-spooling";
import { resultStagingReceiptBinding } from "@workload-funnel/workload-control/result-management";

export interface ScopedUploadIdentity {
  readonly allocationId: string;
  readonly prefix: string;
  readonly permissions: readonly ["create"];
  readonly canList: false;
  readonly canRead: false;
  readonly canOverwrite: false;
  readonly canDelete: false;
}

export interface ArtifactStageEntry {
  readonly path: string;
  readonly digest: string;
  readonly sizeBytes: number;
}

export interface ArtifactStageCommand {
  readonly operationId: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly sealId: string;
  readonly treeDigest: string;
  readonly manifestDigest: string;
  readonly entries: readonly ArtifactStageEntry[];
  readonly uploadIdentity: ScopedUploadIdentity;
  readonly mutationFence: MutationFence;
}

export interface ArtifactStageReceipt {
  readonly bindingDigest: string;
  readonly operationId: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly entries: readonly Readonly<{
    path: string;
    checksum: string;
    sizeBytes: number;
    location: string;
  }>[];
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly state: "staged";
}

export interface ArtifactStageWriter {
  readonly capability: "create_only_scoped_stage";
  stage(command: ArtifactStageCommand): Promise<ArtifactStageReceipt>;
}

export interface ResultStagedObservation {
  readonly bindingDigest: string;
  readonly kind: "ResultStaged";
  readonly eventId: string;
  readonly operationId: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly immutableStagingIdentity: string;
  readonly manifestDigest: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly observedAtMs: number;
  readonly entries: ArtifactStageReceipt["entries"];
}

export function artifactStageReceiptBinding(
  receipt: Pick<
    ArtifactStageReceipt,
    | "entries"
    | "immutableStagingIdentity"
    | "manifestDigest"
    | "mutationFenceFingerprint"
    | "operationId"
  >,
): string {
  return resultStagingReceiptBinding({
    entries: receipt.entries,
    immutableStagingIdentity: receipt.immutableStagingIdentity,
    manifestDigest: receipt.manifestDigest,
    mutationFenceFingerprint: receipt.mutationFenceFingerprint,
    stagingOperationId: receipt.operationId,
  });
}

function assertStageCommand(command: ArtifactStageCommand): void {
  validateMutationFence(command.mutationFence);
  const fence = command.mutationFence;
  const expectedPrefix = `${command.allocationId}/${command.executionGeneration}/`;
  const uploadIdentity = command.uploadIdentity as unknown as Readonly<{
    allocationId?: unknown;
    prefix?: unknown;
    permissions?: unknown;
    canList?: unknown;
    canRead?: unknown;
    canOverwrite?: unknown;
    canDelete?: unknown;
  }>;
  if (
    fence.desiredEffect !== "artifact_stage" ||
    fence.requiredGate !== "result_finalize" ||
    fence.allocationId !== command.allocationId ||
    fence.attemptId !== command.attemptId ||
    fence.executionGeneration !== command.executionGeneration ||
    fence.effectScopeKey !== `artifact-stage:${command.executionId}` ||
    fence.supersessionKey !== fence.effectScopeKey ||
    uploadIdentity.allocationId !== command.allocationId ||
    uploadIdentity.prefix !== expectedPrefix ||
    !Array.isArray(uploadIdentity.permissions) ||
    uploadIdentity.permissions.length !== 1 ||
    uploadIdentity.permissions[0] !== "create" ||
    uploadIdentity.canList !== false ||
    uploadIdentity.canRead !== false ||
    uploadIdentity.canOverwrite !== false ||
    uploadIdentity.canDelete !== false ||
    !/^[a-f0-9]{64}$/u.test(command.treeDigest) ||
    !/^[a-f0-9]{64}$/u.test(command.manifestDigest)
  )
    throw new Error("artifact_stage_authority_mismatch");
}

export interface FeatureApi {
  stageAndReport(
    command: ArtifactStageCommand,
  ): Promise<ResultStagedObservation>;
}

export function createProvider(
  input: Readonly<{
    artifactStageWriter: ArtifactStageWriter;
    observationSpool: DurableObservationSpool;
    nodeId: string;
    nodeBootEpoch: number;
    nowMs?: () => number;
  }>,
): FeatureApi {
  const nowMs = input.nowMs ?? Date.now;
  return Object.freeze({
    async stageAndReport(command: ArtifactStageCommand) {
      assertStageCommand(command);
      const receipt = await input.artifactStageWriter.stage(command);
      if (
        receipt.operationId !== command.operationId ||
        receipt.manifestDigest !== command.manifestDigest ||
        receipt.mutationFenceFingerprint !==
          fingerprintMutationFence(command.mutationFence) ||
        fingerprintMutationFence(receipt.mutationFence) !==
          receipt.mutationFenceFingerprint ||
        !receipt.immutableStagingIdentity.includes(
          Buffer.from(receipt.mutationFenceFingerprint).toString("base64url"),
        ) ||
        receipt.bindingDigest !== artifactStageReceiptBinding(receipt) ||
        receipt.entries.length !== command.entries.length
      )
        throw new Error("artifact_stage_receipt_mismatch");
      const expectedEntries = new Map(
        command.entries.map((entry) => [entry.path, entry] as const),
      );
      for (const entry of receipt.entries) {
        const expected = expectedEntries.get(entry.path);
        if (
          expected?.digest !== entry.checksum ||
          expected.sizeBytes !== entry.sizeBytes ||
          entry.location.length === 0
        )
          throw new Error("artifact_stage_receipt_mismatch");
        expectedEntries.delete(entry.path);
      }
      if (expectedEntries.size !== 0)
        throw new Error("artifact_stage_receipt_mismatch");
      const observedAtMs = nowMs();
      const eventId = `result-staged:${command.operationId}`;
      const observation: ResultStagedObservation = Object.freeze({
        allocationId: command.allocationId,
        attemptId: command.attemptId,
        bindingDigest: receipt.bindingDigest,
        entries: receipt.entries,
        eventId,
        executionGeneration: command.executionGeneration,
        executionId: command.executionId,
        immutableStagingIdentity: receipt.immutableStagingIdentity,
        kind: "ResultStaged",
        manifestDigest: receipt.manifestDigest,
        mutationFence: command.mutationFence,
        mutationFenceFingerprint: receipt.mutationFenceFingerprint,
        observedAtMs,
        operationId: command.operationId,
      });
      const payloadDigest = createHash("sha256")
        .update(JSON.stringify(observation), "utf8")
        .digest("hex");
      input.observationSpool.append({
        bootEpoch: input.nodeBootEpoch,
        eventId,
        executionGeneration: command.executionGeneration,
        executionId: command.executionId,
        kind: "result_staged",
        nodeId: input.nodeId,
        observedAtMs,
        payloadDigest,
        sourceSequence: Math.max(
          1,
          command.mutationFence.expectedDesiredVersion,
        ),
        state: "active",
      });
      return observation;
    },
  });
}
