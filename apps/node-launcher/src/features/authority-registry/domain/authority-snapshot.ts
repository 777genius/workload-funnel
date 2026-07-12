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
  readonly namespace: NamespaceAuthority;
}

export interface AuthorityInstallAcknowledgement {
  readonly allocationId: string;
  readonly allocationOwnerFence: number;
  readonly attemptId: string;
  readonly clusterIncarnationVersion: number;
  readonly gateOpen: boolean;
  readonly gateRevision: number;
  readonly namespaceId: string;
  readonly namespaceWriterEpoch: number;
  readonly result: "idempotent" | "installed";
  readonly startRevocationRevision: number;
}

export type AuthorityRegistryErrorCode =
  | "authority_mismatch"
  | "authority_missing"
  | "invalid_authority"
  | "mutation_in_progress"
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
  if (
    snapshot.allocation.attemptId !== snapshot.attempt.attemptId ||
    snapshot.allocation.executionGeneration !==
      snapshot.attempt.executionGeneration ||
    snapshot.gate.effect !== "process_start"
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
