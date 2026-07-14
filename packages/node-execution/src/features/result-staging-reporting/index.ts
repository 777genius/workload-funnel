import {
  createHash,
  sign as createSignature,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

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

export interface PrivilegedSealReceipt {
  readonly contractVersion: number;
  readonly providerId: string;
  readonly sealOperationId: string;
  readonly sealId: string;
  readonly treeDigest: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly sealMutationFenceFingerprint: string;
  readonly sealTupleFingerprint: string;
  readonly authorityRegistrySequence: number;
  readonly totalBytes: number;
  readonly entries: readonly ArtifactStageEntry[];
  readonly uploadAuthorityDigest: string;
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
}

export interface ArtifactStageCommand {
  readonly operationId: string;
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionId: string;
  readonly executionGeneration: string;
  readonly sealId: string;
  readonly treeDigest: string;
  readonly privilegedSealReceipt?: PrivilegedSealReceipt;
  readonly manifestDigest: string;
  readonly entries: readonly ArtifactStageEntry[];
  readonly uploadIdentity: ScopedUploadIdentity;
  readonly mutationFence: MutationFence;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => key !== "signatureBase64Url")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function scopedUploadAuthorityDigest(
  identity: ScopedUploadIdentity,
): string {
  return createHash("sha256").update(canonical(identity)).digest("hex");
}

function privilegedSealTuple(
  receipt: Omit<
    PrivilegedSealReceipt,
    "sealTupleFingerprint" | "signatureBase64Url"
  >,
): unknown {
  return Object.freeze({
    allocationId: receipt.allocationId,
    attemptId: receipt.attemptId,
    authorityRegistrySequence: receipt.authorityRegistrySequence,
    contractVersion: receipt.contractVersion,
    entries: receipt.entries,
    executionGeneration: receipt.executionGeneration,
    executionId: receipt.executionId,
    providerId: receipt.providerId,
    sealId: receipt.sealId,
    sealMutationFenceFingerprint: receipt.sealMutationFenceFingerprint,
    sealOperationId: receipt.sealOperationId,
    totalBytes: receipt.totalBytes,
    treeDigest: receipt.treeDigest,
    uploadAuthorityDigest: receipt.uploadAuthorityDigest,
  });
}

export function privilegedSealTupleFingerprint(
  receipt: Omit<
    PrivilegedSealReceipt,
    "sealTupleFingerprint" | "signatureBase64Url"
  >,
): string {
  return createHash("sha256")
    .update(canonical(privilegedSealTuple(receipt)))
    .digest("hex");
}

export function signPrivilegedSealReceipt(
  receipt: Omit<
    PrivilegedSealReceipt,
    "sealTupleFingerprint" | "signatureBase64Url"
  >,
  privateKey: KeyObject,
): PrivilegedSealReceipt {
  const unsigned = Object.freeze({
    ...receipt,
    sealTupleFingerprint: privilegedSealTupleFingerprint(receipt),
  });
  return Object.freeze({
    ...unsigned,
    entries: Object.freeze(
      receipt.entries.map((entry) => Object.freeze({ ...entry })),
    ),
    signatureBase64Url: createSignature(
      null,
      Buffer.from(canonical(unsigned), "utf8"),
      privateKey,
    ).toString("base64url"),
  });
}

export function verifyPrivilegedSealReceipt(
  receipt: PrivilegedSealReceipt,
  command: Omit<ArtifactStageCommand, "privilegedSealReceipt">,
  trustedKeys: ReadonlyMap<string, KeyObject>,
  now: number,
): void {
  const publicKey = trustedKeys.get(receipt.signerKeyId);
  const expectedEntries = [...command.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const actualEntries = [...receipt.entries].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (
    receipt.contractVersion !== 1 ||
    receipt.providerId !== "result-sealer" ||
    receipt.sealId !== command.sealId ||
    receipt.treeDigest !== command.treeDigest ||
    receipt.allocationId !== command.allocationId ||
    receipt.attemptId !== command.attemptId ||
    receipt.executionId !== command.executionId ||
    receipt.executionGeneration !== command.executionGeneration ||
    receipt.authorityRegistrySequence < 1 ||
    receipt.totalBytes !==
      command.entries.reduce((total, entry) => total + entry.sizeBytes, 0) ||
    JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries) ||
    receipt.uploadAuthorityDigest !==
      scopedUploadAuthorityDigest(command.uploadIdentity) ||
    !/^fence-v1-[a-f0-9]{64}$/u.test(receipt.sealMutationFenceFingerprint) ||
    receipt.sealTupleFingerprint !== privilegedSealTupleFingerprint(receipt) ||
    now < receipt.issuedAt ||
    now >= receipt.notAfter ||
    receipt.notAfter <= receipt.issuedAt ||
    publicKey === undefined ||
    !verifySignature(
      null,
      Buffer.from(canonical(receipt), "utf8"),
      publicKey,
      Buffer.from(receipt.signatureBase64Url, "base64url"),
    )
  )
    throw new Error("privileged_seal_receipt_invalid");
}

export interface ArtifactStageReceipt {
  readonly bindingDigest: string;
  readonly operationId: string;
  readonly providerId: string;
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
  readonly providerId: string;
  stage(command: ArtifactStageCommand): Promise<ArtifactStageReceipt>;
}

export interface ResultStagedObservation {
  readonly bindingDigest: string;
  readonly kind: "ResultStaged";
  readonly eventId: string;
  readonly operationId: string;
  readonly providerId: string;
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
    | "providerId"
  >,
): string {
  return resultStagingReceiptBinding({
    artifactProviderId: receipt.providerId,
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
    !/^[a-f0-9]{64}$/u.test(command.manifestDigest) ||
    (command.privilegedSealReceipt !== undefined &&
      (command.privilegedSealReceipt.sealId !== command.sealId ||
        command.privilegedSealReceipt.treeDigest !== command.treeDigest ||
        command.privilegedSealReceipt.uploadAuthorityDigest !==
          scopedUploadAuthorityDigest(command.uploadIdentity)))
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
        receipt.providerId !== input.artifactStageWriter.providerId ||
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
        providerId: receipt.providerId,
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
