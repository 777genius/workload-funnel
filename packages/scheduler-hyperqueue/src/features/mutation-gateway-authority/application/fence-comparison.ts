import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import {
  GatewayContractError,
  type SchedulerMutationScope,
} from "../domain/gateway-contract.js";
import { validateFenceForSchedulerScope } from "../domain/gateway-validation.js";

export type InstalledFenceComparison =
  | "dominates"
  | "equal"
  | "equal_version_mismatch"
  | "lower";

function revisions(fence: MutationFence): readonly number[] {
  return [
    fence.clusterIncarnationVersion,
    fence.namespaceWriterEpoch,
    fence.operationGateRevision,
    fence.ownerFence ?? -1,
    fence.issuedStartRevocationRevision ?? -1,
    fence.expectedDesiredVersion,
  ];
}

export function compareInstalledSchedulerFence(
  candidate: MutationFence,
  installed: MutationFence | undefined,
  scope: SchedulerMutationScope,
): InstalledFenceComparison {
  validateFenceForSchedulerScope(candidate, scope);
  if (installed === undefined) return "dominates";
  validateFenceForSchedulerScope(installed, scope);
  const candidateRevisions = revisions(candidate);
  const installedRevisions = revisions(installed);
  let greater = false;
  for (const [index, candidateRevision] of candidateRevisions.entries()) {
    const installedRevision = installedRevisions[index];
    if (installedRevision === undefined)
      throw new GatewayContractError("gateway_cordoned", "revision_vector");
    if (candidateRevision < installedRevision) return "lower";
    if (candidateRevision > installedRevision) greater = true;
  }
  if (!greater) {
    return fingerprintMutationFence(candidate) ===
      fingerprintMutationFence(installed)
      ? "equal"
      : "equal_version_mismatch";
  }
  if (
    candidate.namespaceId !== installed.namespaceId ||
    candidate.attemptId !== installed.attemptId ||
    candidate.executionGeneration !== installed.executionGeneration ||
    candidate.allocationId !== installed.allocationId ||
    candidate.effectScopeKey !== installed.effectScopeKey ||
    candidate.desiredEffect !== installed.desiredEffect ||
    candidate.requiredGate !== installed.requiredGate ||
    candidate.startFence !== installed.startFence ||
    candidate.supersessionKey !== installed.supersessionKey
  )
    return "equal_version_mismatch";
  if (
    candidate.clusterIncarnationVersion ===
      installed.clusterIncarnationVersion &&
    candidate.clusterIncarnation !== installed.clusterIncarnation
  )
    return "equal_version_mismatch";
  return "dominates";
}
