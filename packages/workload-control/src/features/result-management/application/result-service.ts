import {
  assertGateOpen,
  assertMutationFenceGateOpen,
  type OperationGateSet,
} from "@workload-funnel/workload-control/operation-gating";
import type { SyntheticResultFile } from "@workload-funnel/workload-control/workload-lifecycle";
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import type { ResultStore } from "./contracts/result-store.js";
import type { ResultEntry, ResultManifest } from "../domain/result-manifest.js";
import {
  markRetentionDue,
  prepareArtifactOperation,
} from "../domain/result-manifest.js";

function checksum(content: string): string {
  let hash = 0;
  for (const character of content)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) | 0;
  return `synthetic-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface ResultManagementService {
  finalize(command: ResultFinalizeCommand): ResultManifest;
  get(attemptId: string): ResultManifest | undefined;
  getById(resultManifestId: string): ResultManifest | undefined;
  requestRetention(input: {
    readonly resultManifestId: string;
    readonly operationId: string;
    readonly action: "archive" | "delete";
    readonly expectedVersion?: number;
  }): ResultManifest;
}

export interface ArtifactFinalizeCommand {
  readonly authority: ArtifactFinalizeAuthority;
  readonly attemptId: string;
  readonly content: string;
  readonly mutationFence: MutationFence;
  readonly path: string;
}

export interface ArtifactFinalizeAuthority {
  readonly allocationId?: string;
  readonly attemptId: string;
  readonly clusterIncarnation: string;
  readonly clusterIncarnationVersion: number;
  readonly desiredEffect: "artifact_finalize";
  readonly effectScopeKey: string;
  readonly executionGeneration: string;
  readonly expectedDesiredVersion: number;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly openGates: ReadonlySet<string>;
  readonly operationGateRevision: number;
  readonly ownerFence?: number;
  readonly requiredGate: "result_finalize";
  readonly supersessionKey: string;
}

export interface ResultFinalizeCommand {
  readonly attemptId: string;
  readonly executionId?: string;
  readonly files: readonly (SyntheticResultFile & {
    readonly location?: string;
  })[];
  readonly mutationFence: MutationFence;
}

interface SyntheticFinalizeAuthority {
  readonly allocationId?: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly gateRevision: number;
  readonly namespaceId: string;
  readonly openGates: ReadonlySet<string>;
  readonly ownerFence?: number;
}

function createSyntheticFinalizeFence(
  authority: SyntheticFinalizeAuthority,
  effectScopeKey: string,
): MutationFence {
  if (
    (authority.allocationId === undefined) !==
    (authority.ownerFence === undefined)
  ) {
    throw new Error("synthetic_result_allocation_authority_incomplete");
  }
  const mutationFence: MutationFence = Object.freeze({
    ...(authority.allocationId === undefined
      ? {}
      : {
          allocationId: authority.allocationId,
          ownerFence: authority.ownerFence,
        }),
    attemptId: authority.attemptId,
    clusterIncarnation: "synthetic-phase1-cluster",
    clusterIncarnationVersion: 1,
    desiredEffect: "artifact_finalize",
    effectScopeKey,
    executionGeneration: authority.executionGeneration,
    expectedDesiredVersion: 1,
    namespaceId: authority.namespaceId,
    namespaceWriterEpoch: 1,
    operationGateRevision: authority.gateRevision,
    requiredGate: "result_finalize",
    schemaVersion: 1,
    supersessionKey: effectScopeKey,
  });
  validateMutationFence(mutationFence);
  return mutationFence;
}

export function createSyntheticArtifactFinalizeCommand(
  input: SyntheticFinalizeAuthority &
    Readonly<{ content: string; path: string }>,
): ArtifactFinalizeCommand {
  const pathScope = Buffer.from(input.path, "utf8").toString("base64url");
  return Object.freeze({
    authority: Object.freeze({
      ...(input.allocationId === undefined
        ? {}
        : {
            allocationId: input.allocationId,
            ownerFence: input.ownerFence,
          }),
      attemptId: input.attemptId,
      clusterIncarnation: "synthetic-phase1-cluster",
      clusterIncarnationVersion: 1,
      desiredEffect: "artifact_finalize",
      effectScopeKey: `artifact-finalize:${input.attemptId}:${pathScope}`,
      executionGeneration: input.executionGeneration,
      expectedDesiredVersion: 1,
      namespaceId: input.namespaceId,
      namespaceWriterEpoch: 1,
      openGates: input.openGates,
      operationGateRevision: input.gateRevision,
      requiredGate: "result_finalize",
      supersessionKey: `artifact-finalize:${input.attemptId}:${pathScope}`,
    }),
    attemptId: input.attemptId,
    content: input.content,
    mutationFence: createSyntheticFinalizeFence(
      input,
      `artifact-finalize:${input.attemptId}:${pathScope}`,
    ),
    path: input.path,
  });
}

export function createSyntheticResultFinalizeCommand(
  input: SyntheticFinalizeAuthority &
    Readonly<{
      executionId?: string;
      files: readonly (SyntheticResultFile & { readonly location?: string })[];
    }>,
): ResultFinalizeCommand {
  return Object.freeze({
    attemptId: input.attemptId,
    ...(input.executionId === undefined
      ? {}
      : { executionId: input.executionId }),
    files: input.files,
    mutationFence: createSyntheticFinalizeFence(
      input,
      `result-finalize:${input.attemptId}`,
    ),
  });
}

export function createResultManagementService(
  store: ResultStore,
  gates: () => OperationGateSet,
): ResultManagementService {
  const service: ResultManagementService = {
    finalize(command) {
      const { attemptId, executionId, files, mutationFence } = command;
      const prior = store.getByAttempt(attemptId);
      if (prior !== undefined) {
        if (prior.attemptId !== mutationFence.attemptId) {
          throw new Error("result_finalize_operation_conflict");
        }
        return prior;
      }
      assertMutationFenceGateOpen(gates(), mutationFence, "result_finalize");
      if (
        mutationFence.desiredEffect !== "artifact_finalize" ||
        mutationFence.attemptId !== attemptId ||
        mutationFence.effectScopeKey !== `result-finalize:${attemptId}` ||
        mutationFence.supersessionKey !== mutationFence.effectScopeKey
      ) {
        throw new Error("result_finalize_fence_mismatch");
      }
      const entries: readonly ResultEntry[] = Object.freeze(
        [...files]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map((file) =>
            Object.freeze({
              checksum: checksum(file.content),
              location:
                file.location ??
                `file://synthetic-results/${attemptId}/${file.path}`,
              path: file.path,
              sizeBytes: Buffer.byteLength(file.content),
            }),
          ),
      );
      return store.create(
        Object.freeze({
          attemptId,
          complete: true,
          entries,
          ...(executionId === undefined ? {} : { executionId }),
          resultManifestId: `manifest-${attemptId.slice("attempt-".length)}`,
          retentionClass: "synthetic-ephemeral",
          retentionState: "active",
          version: 1,
        }),
      );
    },
    get: (attemptId) => store.getByAttempt(attemptId),
    getById: (resultManifestId) => store.get(resultManifestId),
    requestRetention(input) {
      const manifest = store.get(input.resultManifestId);
      if (manifest === undefined) throw new Error("not_found");
      const prior = manifest.artifactOperation;
      if (prior?.operationId === input.operationId) return manifest;
      if (
        input.expectedVersion !== undefined &&
        manifest.version !== input.expectedVersion
      )
        throw new Error("result_version_conflict");
      assertGateOpen(
        gates(),
        input.action === "archive" ? "result_archive" : "result_delete",
      );
      const due =
        manifest.retentionState === "active"
          ? markRetentionDue(manifest)
          : manifest;
      const next = prepareArtifactOperation(
        due,
        input.operationId,
        input.action,
      );
      return store.save(next, manifest.version);
    },
  };
  return Object.freeze(service);
}
