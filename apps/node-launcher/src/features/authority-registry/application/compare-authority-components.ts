import type {
  AllocationAuthority,
  AttemptStartAuthority,
  ClusterAuthority,
  NamespaceAuthority,
} from "@workload-funnel/node-execution/execution-ticket-validation";
import type { MutationFence } from "@workload-funnel/kernel";

import {
  AuthorityRegistryError,
  type LauncherAuthoritySnapshot,
  type LauncherGateAuthority,
  rejectLowerOrMismatch,
  sameAllocation,
  sameAttempt,
  sameCluster,
  sameNamespace,
} from "../domain/authority-snapshot.js";

export function compareAuthorityComponents(
  cluster: ClusterAuthority | undefined,
  snapshot: LauncherAuthoritySnapshot,
  currentNamespace: NamespaceAuthority | undefined,
  currentAllocation: AllocationAuthority | undefined,
  currentAttempt: AttemptStartAuthority | undefined,
  currentGate: LauncherGateAuthority | undefined,
  currentScope: LauncherAuthoritySnapshot | undefined,
): void {
  const mutationFence: MutationFence = snapshot.mutationFence;
  if (cluster !== undefined) {
    rejectLowerOrMismatch(
      cluster.version,
      snapshot.cluster.version,
      sameCluster(cluster, snapshot.cluster),
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
      currentGate.open === snapshot.gate.open &&
        currentGate.effect === snapshot.gate.effect,
      "operation gate",
    );
  }
  if (currentScope !== undefined) {
    rejectLowerOrMismatch(
      currentScope.mutationFence.expectedDesiredVersion,
      mutationFence.expectedDesiredVersion,
      currentScope.mutationFence.desiredEffect ===
        mutationFence.desiredEffect &&
        currentScope.mutationFence.supersessionKey ===
          mutationFence.supersessionKey &&
        currentScope.mutationFenceFingerprint ===
          snapshot.mutationFenceFingerprint,
      "desired effect",
    );
  }
}
