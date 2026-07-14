import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export type FinalMutationAuthorityKind =
  | "artifact-store"
  | "node-launcher"
  | "result-sealer"
  | "runtime-broker"
  | "scheduler-gateway";

const requiredFinalAuthorityKinds: readonly FinalMutationAuthorityKind[] =
  Object.freeze([
    "artifact-store",
    "node-launcher",
    "result-sealer",
    "runtime-broker",
    "scheduler-gateway",
  ]);

export type MutationFenceHighWatermarkComponent =
  | "allocation_owner"
  | "attempt_revocation"
  | "cluster_incarnation"
  | "complete_tuple"
  | "desired_effect"
  | "namespace_writer"
  | "node_boot"
  | "operation_gate";

export interface MutationFenceHighWatermarkRecord {
  readonly component: MutationFenceHighWatermarkComponent;
  readonly key: string;
  readonly version: number;
  readonly identity: string;
}

export interface FinalMutationAuthorityTarget {
  readonly authorityId: string;
  readonly authorityKind: FinalMutationAuthorityKind;
  readonly writerIdentity: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly highWatermarks: readonly MutationFenceHighWatermarkRecord[];
}

export interface AuthoritativeFinalAuthorityInventoryReceipt {
  readonly inventoryId: string;
  readonly operationId: string;
  readonly namespaceId: string;
  readonly targetEpoch: number;
  readonly inventoryRevision: number;
  readonly complete: boolean;
  readonly durable: boolean;
  readonly issuedAt: number;
  readonly notAfter: number;
  readonly inventoryDigest: string;
  readonly signerKeyId: string;
  readonly signatureBase64Url: string;
  readonly targets: readonly FinalMutationAuthorityTarget[];
}

export interface FinalAuthorityCloseAcknowledgement {
  readonly operationId: string;
  readonly authorityId: string;
  readonly effectScopeKey: string;
  readonly closed: boolean;
  readonly durable: boolean;
}

export interface FinalAuthorityDrainAcknowledgement {
  readonly operationId: string;
  readonly authorityId: string;
  readonly effectScopeKey: string;
  readonly closeOperationId: string;
  readonly drained: boolean;
  readonly durable: boolean;
}

export interface CompleteFenceInstallAcknowledgement {
  readonly operationId: string;
  readonly authorityId: string;
  readonly authorityKind: FinalMutationAuthorityKind;
  readonly effectScopeKey: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly highWatermarks: readonly MutationFenceHighWatermarkRecord[];
  readonly durableSequence: number;
  readonly installed: boolean;
}

export type ControlServiceFailoverPhase =
  | "pending"
  | "scopes_closed"
  | "old_calls_drained"
  | "epoch_advanced"
  | "authorities_installed"
  | "old_credentials_disabled"
  | "completed";

export interface ControlServiceFailoverOperation {
  readonly operationId: string;
  readonly namespaceId: string;
  readonly fromWriterId: string;
  readonly toWriterId: string;
  readonly expectedCurrentEpoch: number;
  readonly targetEpoch: number;
  readonly targets: readonly FinalMutationAuthorityTarget[];
  readonly authorityInventory: AuthoritativeFinalAuthorityInventoryReceipt;
  readonly phase: ControlServiceFailoverPhase;
  readonly closeAcknowledgements: readonly FinalAuthorityCloseAcknowledgement[];
  readonly drainAcknowledgements: readonly FinalAuthorityDrainAcknowledgement[];
  readonly installAcknowledgements: readonly CompleteFenceInstallAcknowledgement[];
  readonly evidence: Readonly<Record<string, string>>;
  readonly version: number;
}

export class ControlServiceFailoverError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ControlServiceFailoverError";
  }
}

function tuple(...values: readonly string[]): string {
  return values.join("\u0000");
}

function record(
  component: MutationFenceHighWatermarkComponent,
  key: string,
  version: number,
  identity: string,
): MutationFenceHighWatermarkRecord {
  return Object.freeze({ component, identity, key, version });
}

export function completeMutationFenceHighWatermarks(
  fence: MutationFence,
  writerIdentity: string,
): readonly MutationFenceHighWatermarkRecord[] {
  validateMutationFence(fence);
  if (!writerIdentity)
    throw new ControlServiceFailoverError("failover_writer_identity_missing");
  const records: MutationFenceHighWatermarkRecord[] = [
    record(
      "cluster_incarnation",
      "cluster",
      fence.clusterIncarnationVersion,
      fence.clusterIncarnation,
    ),
    record(
      "namespace_writer",
      fence.namespaceId,
      fence.namespaceWriterEpoch,
      writerIdentity,
    ),
    record(
      "operation_gate",
      tuple(fence.namespaceId, fence.requiredGate),
      fence.operationGateRevision,
      fence.requiredGate,
    ),
    record(
      "desired_effect",
      fence.effectScopeKey,
      fence.expectedDesiredVersion,
      tuple(fence.desiredEffect, fence.supersessionKey),
    ),
    record(
      "complete_tuple",
      fence.effectScopeKey,
      fence.expectedDesiredVersion,
      fingerprintMutationFence(fence),
    ),
  ];
  if (fence.allocationId !== undefined && fence.ownerFence !== undefined)
    records.push(
      record(
        "allocation_owner",
        fence.allocationId,
        fence.ownerFence,
        tuple(fence.allocationId, fence.attemptId, fence.executionGeneration),
      ),
    );
  if (
    fence.startFence !== undefined &&
    fence.issuedStartRevocationRevision !== undefined
  )
    records.push(
      record(
        "attempt_revocation",
        tuple(fence.attemptId, fence.executionGeneration),
        fence.issuedStartRevocationRevision,
        fence.startFence,
      ),
    );
  if (fence.nodeId !== undefined && fence.nodeBootEpoch !== undefined)
    records.push(
      record("node_boot", fence.nodeId, fence.nodeBootEpoch, fence.nodeId),
    );
  return Object.freeze(
    records.sort((left, right) =>
      `${left.component}\u0000${left.key}`.localeCompare(
        `${right.component}\u0000${right.key}`,
      ),
    ),
  );
}

export function assertCompleteFenceTarget(
  target: FinalMutationAuthorityTarget,
  namespaceId: string,
  targetEpoch: number,
  writerIdentity: string,
): void {
  validateMutationFence(target.mutationFence);
  if (
    !target.authorityId ||
    target.mutationFence.namespaceId !== namespaceId ||
    target.mutationFence.namespaceWriterEpoch !== targetEpoch ||
    target.writerIdentity !== writerIdentity ||
    target.mutationFenceFingerprint !==
      fingerprintMutationFence(target.mutationFence) ||
    JSON.stringify(target.highWatermarks) !==
      JSON.stringify(
        completeMutationFenceHighWatermarks(
          target.mutationFence,
          target.writerIdentity,
        ),
      )
  )
    throw new ControlServiceFailoverError(
      "incomplete_failover_authority_target",
    );
}

export function assertCompleteFenceInstallAcknowledgement(
  target: FinalMutationAuthorityTarget,
  acknowledgement: CompleteFenceInstallAcknowledgement,
  operationId: string,
): void {
  if (
    acknowledgement.operationId !== operationId ||
    acknowledgement.authorityId !== target.authorityId ||
    acknowledgement.authorityKind !== target.authorityKind ||
    acknowledgement.effectScopeKey !== target.mutationFence.effectScopeKey ||
    acknowledgement.mutationFenceFingerprint !==
      target.mutationFenceFingerprint ||
    fingerprintMutationFence(acknowledgement.mutationFence) !==
      target.mutationFenceFingerprint ||
    JSON.stringify(acknowledgement.highWatermarks) !==
      JSON.stringify(target.highWatermarks) ||
    !acknowledgement.installed ||
    !Number.isSafeInteger(acknowledgement.durableSequence) ||
    acknowledgement.durableSequence < 1
  )
    throw new ControlServiceFailoverError("failover_install_ack_mismatch");
}

export function createControlServiceFailoverOperation(
  input: Omit<
    ControlServiceFailoverOperation,
    | "targets"
    | "phase"
    | "closeAcknowledgements"
    | "drainAcknowledgements"
    | "installAcknowledgements"
    | "evidence"
    | "version"
  > &
    Readonly<{
      authorityInventory: AuthoritativeFinalAuthorityInventoryReceipt;
    }>,
): ControlServiceFailoverOperation {
  const targets = input.authorityInventory.targets;
  if (
    input.targetEpoch !== input.expectedCurrentEpoch + 1 ||
    input.authorityInventory.operationId !== input.operationId ||
    input.authorityInventory.namespaceId !== input.namespaceId ||
    input.authorityInventory.targetEpoch !== input.targetEpoch ||
    !input.authorityInventory.complete ||
    !input.authorityInventory.durable ||
    input.authorityInventory.inventoryRevision < 1 ||
    !/^[a-f0-9]{64}$/u.test(input.authorityInventory.inventoryDigest) ||
    targets.length < 1 ||
    requiredFinalAuthorityKinds.some(
      (kind) => !targets.some((target) => target.authorityKind === kind),
    ) ||
    new Set(
      targets.map(
        (target) =>
          `${target.authorityId}\u0000${target.mutationFence.effectScopeKey}`,
      ),
    ).size !== targets.length
  )
    throw new ControlServiceFailoverError(
      "invalid_failover_authority_inventory",
    );
  for (const target of targets)
    assertCompleteFenceTarget(
      target,
      input.namespaceId,
      input.targetEpoch,
      input.toWriterId,
    );
  return Object.freeze({
    ...input,
    closeAcknowledgements: Object.freeze([]),
    drainAcknowledgements: Object.freeze([]),
    evidence: Object.freeze({}),
    installAcknowledgements: Object.freeze([]),
    phase: "pending",
    authorityInventory: Object.freeze({
      ...input.authorityInventory,
      targets: Object.freeze([...targets]),
    }),
    targets: Object.freeze([...targets]),
    version: 1,
  });
}
