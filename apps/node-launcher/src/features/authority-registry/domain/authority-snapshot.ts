import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type {
  AllocationAuthority,
  AttemptStartAuthority,
  ClusterAuthority,
  NamespaceAuthority,
} from "@workload-funnel/node-execution/execution-ticket-validation";

export interface LauncherGateAuthority {
  readonly effect: string;
  readonly open: boolean;
  readonly revision: number;
}

export interface LauncherAuthoritySnapshot {
  readonly allocation: AllocationAuthority;
  readonly attempt: AttemptStartAuthority;
  readonly cluster: ClusterAuthority;
  readonly gate: LauncherGateAuthority;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly namespace: NamespaceAuthority;
}

export interface AuthorityInstallAcknowledgement {
  readonly allocationId: string;
  readonly allocationOwnerFence: number;
  readonly allocationOwnerId: string;
  readonly attemptId: string;
  readonly clusterIncarnation: string;
  readonly clusterIncarnationVersion: number;
  readonly gateOpen: boolean;
  readonly gateRevision: number;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly namespaceWriterId: string;
  readonly effectScopeKey: string;
  readonly expectedDesiredVersion: number;
  readonly mutationFenceFingerprint: string;
  readonly mutationFence: MutationFence;
  readonly result: "idempotent" | "installed";
  readonly startRevocationRevision: number;
  readonly supersessionKey: string;
  readonly walSequence: number;
}

export type AuthorityRegistryErrorCode =
  | "authority_mismatch"
  | "authority_missing"
  | "invalid_authority"
  | "launcher_cordoned"
  | "mutation_in_progress"
  | "nonce_replay"
  | "stale_authority";

export class AuthorityRegistryError extends Error {
  public constructor(
    public readonly code: AuthorityRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AuthorityRegistryError";
  }
}

export function sameCluster(
  left: ClusterAuthority,
  right: ClusterAuthority,
): boolean {
  return (
    left.version === right.version && left.incarnationId === right.incarnationId
  );
}

export function sameNamespace(
  left: NamespaceAuthority,
  right: NamespaceAuthority,
): boolean {
  return (
    left.namespaceId === right.namespaceId &&
    left.writerEpoch === right.writerEpoch &&
    left.writerId === right.writerId
  );
}

export function sameAllocation(
  left: AllocationAuthority,
  right: AllocationAuthority,
): boolean {
  return (
    left.allocationId === right.allocationId &&
    left.ownerFence === right.ownerFence &&
    left.ownerId === right.ownerId &&
    left.attemptId === right.attemptId &&
    left.executionGeneration === right.executionGeneration
  );
}

export function sameAttempt(
  left: AttemptStartAuthority,
  right: AttemptStartAuthority,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.executionGeneration === right.executionGeneration &&
    left.startFence === right.startFence &&
    left.startRevocationRevision === right.startRevocationRevision
  );
}

export function validateSnapshot(snapshot: LauncherAuthoritySnapshot): void {
  try {
    validateMutationFence(snapshot.mutationFence);
  } catch {
    throw new AuthorityRegistryError(
      "invalid_authority",
      "authority snapshot has an invalid complete MutationFence",
    );
  }
  if (
    snapshot.allocation.attemptId !== snapshot.attempt.attemptId ||
    snapshot.allocation.executionGeneration !==
      snapshot.attempt.executionGeneration ||
    snapshot.gate.effect !== snapshot.mutationFence.desiredEffect ||
    !["process_start", "process_stop"].includes(snapshot.gate.effect) ||
    snapshot.mutationFenceFingerprint !==
      fingerprintMutationFence(snapshot.mutationFence) ||
    snapshot.mutationFence.clusterIncarnation !==
      snapshot.cluster.incarnationId ||
    snapshot.mutationFence.clusterIncarnationVersion !==
      snapshot.cluster.version ||
    snapshot.mutationFence.namespaceId !== snapshot.namespace.namespaceId ||
    snapshot.mutationFence.namespaceWriterEpoch !==
      snapshot.namespace.writerEpoch ||
    snapshot.mutationFence.operationGateRevision !== snapshot.gate.revision ||
    snapshot.mutationFence.requiredGate !== snapshot.gate.effect ||
    snapshot.mutationFence.allocationId !== snapshot.allocation.allocationId ||
    snapshot.mutationFence.ownerFence !== snapshot.allocation.ownerFence ||
    snapshot.mutationFence.attemptId !== snapshot.attempt.attemptId ||
    snapshot.mutationFence.executionGeneration !==
      snapshot.attempt.executionGeneration ||
    (snapshot.mutationFence.desiredEffect === "process_start" &&
      (snapshot.mutationFence.startFence !== snapshot.attempt.startFence ||
        snapshot.mutationFence.issuedStartRevocationRevision !==
          snapshot.attempt.startRevocationRevision))
  ) {
    throw new AuthorityRegistryError(
      "invalid_authority",
      "authority snapshot has inconsistent immutable identity",
    );
  }
  for (const value of [
    snapshot.cluster.version,
    snapshot.namespace.writerEpoch,
    snapshot.allocation.ownerFence,
    snapshot.attempt.startRevocationRevision,
    snapshot.gate.revision,
    snapshot.mutationFence.expectedDesiredVersion,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "authority versions must be non-negative safe integers",
      );
    }
  }
}

export function rejectLowerOrMismatch(
  currentVersion: number,
  proposedVersion: number,
  equalIdentity: boolean,
  component: string,
): void {
  if (proposedVersion < currentVersion) {
    throw new AuthorityRegistryError(
      "stale_authority",
      `${component} authority is stale`,
    );
  }
  if (proposedVersion === currentVersion && !equalIdentity) {
    throw new AuthorityRegistryError(
      "authority_mismatch",
      `${component} authority reuses a version with another identity`,
    );
  }
}
