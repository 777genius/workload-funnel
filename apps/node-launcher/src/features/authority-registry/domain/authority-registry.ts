import type {
  AllocationAuthority,
  AttemptStartAuthority,
  ClusterAuthority,
  ExecutionTicketClaims,
  NamespaceAuthority,
} from "@workload-funnel/node-execution/execution-ticket-validation";
import {
  AuthorityRegistryError,
  type AuthorityInstallAcknowledgement,
  type LauncherAuthoritySnapshot,
  type LauncherGateAuthority,
  rejectLowerOrMismatch,
  sameAllocation,
  sameAttempt,
  sameCluster,
  sameNamespace,
  validateSnapshot,
} from "./authority-snapshot.js";

export class RootAuthorityRegistry {
  readonly #allocations = new Map<string, AllocationAuthority>();
  readonly #attempts = new Map<string, AttemptStartAuthority>();
  readonly #gates = new Map<string, LauncherGateAuthority>();
  readonly #namespaces = new Map<string, NamespaceAuthority>();
  #cluster: ClusterAuthority | undefined;
  #insideFinalMutation = false;

  public install(
    snapshot: LauncherAuthoritySnapshot,
  ): AuthorityInstallAcknowledgement {
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "authority cannot change inside the final mutation boundary",
      );
    }
    validateSnapshot(snapshot);
    const currentNamespace = this.#namespaces.get(
      snapshot.namespace.namespaceId,
    );
    const currentAllocation = this.#allocations.get(
      snapshot.allocation.allocationId,
    );
    const currentAttempt = this.#attempts.get(snapshot.attempt.attemptId);
    const currentGate = this.#gates.get(snapshot.namespace.namespaceId);

    if (this.#cluster !== undefined) {
      rejectLowerOrMismatch(
        this.#cluster.version,
        snapshot.cluster.version,
        sameCluster(this.#cluster, snapshot.cluster),
        "cluster incarnation",
      );
    }
    if (currentNamespace !== undefined) {
      rejectLowerOrMismatch(
        currentNamespace.writerEpoch,
        snapshot.namespace.writerEpoch,
        sameNamespace(currentNamespace, snapshot.namespace),
        "namespace writer",
      );
    }
    if (currentAllocation !== undefined) {
      if (
        currentAllocation.attemptId !== snapshot.allocation.attemptId ||
        currentAllocation.executionGeneration !==
          snapshot.allocation.executionGeneration
      ) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "Allocation immutable Attempt fingerprint changed",
        );
      }
      rejectLowerOrMismatch(
        currentAllocation.ownerFence,
        snapshot.allocation.ownerFence,
        sameAllocation(currentAllocation, snapshot.allocation),
        "Allocation owner",
      );
    }
    if (currentAttempt !== undefined) {
      if (
        currentAttempt.executionGeneration !==
          snapshot.attempt.executionGeneration ||
        currentAttempt.startFence !== snapshot.attempt.startFence
      ) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "Attempt immutable start identity changed",
        );
      }
      rejectLowerOrMismatch(
        currentAttempt.startRevocationRevision,
        snapshot.attempt.startRevocationRevision,
        sameAttempt(currentAttempt, snapshot.attempt),
        "Attempt start revocation",
      );
    }
    if (currentGate !== undefined) {
      rejectLowerOrMismatch(
        currentGate.revision,
        snapshot.gate.revision,
        currentGate.open === snapshot.gate.open,
        "operation gate",
      );
    }

    const idempotent =
      this.#cluster !== undefined &&
      currentNamespace !== undefined &&
      currentAllocation !== undefined &&
      currentAttempt !== undefined &&
      currentGate !== undefined &&
      sameCluster(this.#cluster, snapshot.cluster) &&
      sameNamespace(currentNamespace, snapshot.namespace) &&
      sameAllocation(currentAllocation, snapshot.allocation) &&
      sameAttempt(currentAttempt, snapshot.attempt) &&
      currentGate.revision === snapshot.gate.revision &&
      currentGate.open === snapshot.gate.open;

    this.#cluster = Object.freeze({ ...snapshot.cluster });
    this.#namespaces.set(
      snapshot.namespace.namespaceId,
      Object.freeze({ ...snapshot.namespace }),
    );
    this.#allocations.set(
      snapshot.allocation.allocationId,
      Object.freeze({ ...snapshot.allocation }),
    );
    this.#attempts.set(
      snapshot.attempt.attemptId,
      Object.freeze({ ...snapshot.attempt }),
    );
    this.#gates.set(
      snapshot.namespace.namespaceId,
      Object.freeze({ ...snapshot.gate }),
    );
    return {
      allocationId: snapshot.allocation.allocationId,
      allocationOwnerFence: snapshot.allocation.ownerFence,
      attemptId: snapshot.attempt.attemptId,
      clusterIncarnationVersion: snapshot.cluster.version,
      gateOpen: snapshot.gate.open,
      gateRevision: snapshot.gate.revision,
      namespaceId: snapshot.namespace.namespaceId,
      namespaceWriterEpoch: snapshot.namespace.writerEpoch,
      result: idempotent ? "idempotent" : "installed",
      startRevocationRevision: snapshot.attempt.startRevocationRevision,
    };
  }

  public runAuthorizedStart<T>(
    claims: ExecutionTicketClaims,
    mutation: () => T,
  ): T {
    if (this.#insideFinalMutation) {
      throw new AuthorityRegistryError(
        "mutation_in_progress",
        "nested final mutation is forbidden",
      );
    }
    const namespace = this.#namespaces.get(claims.namespace.namespaceId);
    const allocation = this.#allocations.get(claims.allocation.allocationId);
    const attempt = this.#attempts.get(claims.attempt.attemptId);
    const gate = this.#gates.get(claims.namespace.namespaceId);
    if (
      this.#cluster === undefined ||
      namespace === undefined ||
      allocation === undefined ||
      attempt === undefined ||
      gate === undefined
    ) {
      throw new AuthorityRegistryError(
        "authority_missing",
        "complete root authority is not installed",
      );
    }
    if (
      !sameCluster(this.#cluster, claims.cluster) ||
      !sameNamespace(namespace, claims.namespace) ||
      !sameAllocation(allocation, claims.allocation) ||
      !sameAttempt(attempt, claims.attempt) ||
      gate.revision !== claims.gate.revision ||
      !gate.open
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "ticket does not equal root-owned start authority",
      );
    }
    this.#insideFinalMutation = true;
    try {
      return mutation();
    } finally {
      this.#insideFinalMutation = false;
    }
  }

  public assertKnownProcessIdentity(claims: ExecutionTicketClaims): void {
    const attempt = this.#attempts.get(claims.attempt.attemptId);
    const allocation = this.#allocations.get(claims.allocation.allocationId);
    if (
      attempt === undefined ||
      allocation === undefined ||
      attempt.executionGeneration !== claims.attempt.executionGeneration ||
      attempt.startFence !== claims.attempt.startFence ||
      allocation.attemptId !== claims.attempt.attemptId ||
      allocation.executionGeneration !== claims.attempt.executionGeneration
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "process identity is not known to root authority",
      );
    }
  }
}
