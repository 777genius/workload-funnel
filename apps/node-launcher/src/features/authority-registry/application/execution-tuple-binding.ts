import type { ExecutionTicketClaims } from "@workload-funnel/node-execution/execution-ticket-validation";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import type { LauncherWal } from "./launcher-wal.js";
import type { BreakGlassStopInput } from "./durable-break-glass-registry.js";
import type { LauncherAuthoritySnapshot } from "../domain/authority-snapshot.js";
import type {
  BreakGlassWalRecord,
  ControlPartitionWalRecord,
  StartWalRecord,
} from "../domain/launcher-wal-record.js";

function fingerprint(fence: MutationFence): string {
  return fingerprintMutationFence(fence);
}

export function sameBreakGlassIntent(
  prior: BreakGlassWalRecord,
  input: BreakGlassStopInput,
): boolean {
  return (
    prior.attemptId === input.attemptId &&
    prior.executionGeneration === input.executionGeneration &&
    prior.mutationFenceFingerprint === input.mutationFenceFingerprint &&
    prior.nodeBootEpoch === input.nodeBootEpoch &&
    prior.nodeBootId === input.nodeBootId &&
    prior.nodeId === input.nodeId &&
    prior.operationId === input.operationId &&
    prior.reason === input.reason &&
    prior.unitName === input.unitName &&
    fingerprint(prior.mutationFence) === fingerprint(input.mutationFence)
  );
}

export function assertRecoveredStartBinding(
  wal: LauncherWal,
  start: StartWalRecord,
): void {
  const authority = wal.records[start.authorityWalSequence - 1];
  if (
    authority?.sequence !== start.authorityWalSequence ||
    authority.record.kind !== "authority_installed" ||
    authority.record.snapshot.mutationFenceFingerprint !==
      start.mutationFenceFingerprint ||
    authority.record.snapshot.attempt.attemptId !== start.attemptId ||
    authority.record.snapshot.attempt.executionGeneration !==
      start.executionGeneration ||
    start.mutationFence.attemptId !== start.attemptId ||
    start.mutationFence.executionGeneration !== start.executionGeneration ||
    start.mutationFence.nodeId !== start.nodeId ||
    start.mutationFence.nodeBootEpoch !== start.nodeBootEpoch
  ) {
    throw new Error("start WAL is not bound to its installed authority");
  }
}

export function exactStartForClaims(
  starts: Iterable<StartWalRecord>,
  claims: ExecutionTicketClaims,
  unitName: string,
): StartWalRecord | undefined {
  return [...starts].find(
    (candidate) =>
      candidate.unitName === unitName &&
      candidate.state !== "redeemed" &&
      candidate.attemptId === claims.attempt.attemptId &&
      candidate.executionGeneration === claims.attempt.executionGeneration &&
      candidate.nodeId === claims.node.nodeId &&
      candidate.nodeBootId === claims.node.bootId &&
      candidate.nodeBootEpoch === claims.node.bootEpoch &&
      candidate.partitionPolicy === claims.partitionPolicy &&
      candidate.executionDeadlineMs === claims.expiresAtMs &&
      candidate.mutationFenceFingerprint === claims.mutationFenceFingerprint,
  );
}

export function recoveredStartForPartition(
  starts: Iterable<StartWalRecord>,
  partition: ControlPartitionWalRecord,
): StartWalRecord | undefined {
  return [...starts].find(
    (candidate) =>
      candidate.unitName === partition.unitName &&
      candidate.state !== "redeemed" &&
      candidate.attemptId === partition.attemptId &&
      candidate.executionGeneration === partition.executionGeneration &&
      candidate.nodeId === partition.nodeId &&
      candidate.nodeBootId === partition.nodeBootId &&
      candidate.nodeBootEpoch === partition.nodeBootEpoch &&
      candidate.partitionPolicy === partition.partitionPolicy &&
      candidate.mutationFenceFingerprint === partition.mutationFenceFingerprint,
  );
}

export function isExactOwnedExecution(
  input: BreakGlassStopInput,
  starts: Iterable<StartWalRecord>,
  snapshots: ReadonlyMap<string, LauncherAuthoritySnapshot>,
  wal: LauncherWal,
): boolean {
  if (
    input.mutationFenceFingerprint !== fingerprint(input.mutationFence) ||
    input.mutationFence.attemptId !== input.attemptId ||
    input.mutationFence.executionGeneration !== input.executionGeneration ||
    input.mutationFence.nodeId !== input.nodeId ||
    input.mutationFence.nodeBootEpoch !== input.nodeBootEpoch
  ) {
    return false;
  }
  const installed = snapshots.get(input.mutationFence.effectScopeKey);
  const start = [...starts].find(
    (candidate) =>
      candidate.unitName === input.unitName &&
      candidate.state !== "redeemed" &&
      candidate.attemptId === input.attemptId &&
      candidate.executionGeneration === input.executionGeneration &&
      candidate.nodeId === input.nodeId &&
      candidate.nodeBootId === input.nodeBootId &&
      candidate.nodeBootEpoch === input.nodeBootEpoch &&
      candidate.mutationFenceFingerprint === input.mutationFenceFingerprint,
  );
  if (
    installed?.mutationFenceFingerprint !== input.mutationFenceFingerprint ||
    start === undefined
  ) {
    return false;
  }
  const authority = wal.records[start.authorityWalSequence - 1];
  return (
    authority?.sequence === start.authorityWalSequence &&
    authority.record.kind === "authority_installed" &&
    authority.record.snapshot.mutationFenceFingerprint ===
      input.mutationFenceFingerprint &&
    authority.record.snapshot.attempt.attemptId === input.attemptId &&
    authority.record.snapshot.attempt.executionGeneration ===
      input.executionGeneration
  );
}
