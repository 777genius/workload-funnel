import type { ResourceRequest } from "@workload-funnel/workload-control/workload-lifecycle";

export interface Allocation {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly nodeId: "synthetic-node-1";
  readonly resources: ResourceRequest;
  readonly state: "reserved" | "claimed" | "active" | "releasing" | "released";
  readonly leaseState: "unowned" | "current" | "expired" | "revoked";
  readonly leaseOwnerId?: string;
  readonly leaseUntil?: number;
  readonly ownerFence: number;
  readonly version: number;
}

export interface CapacitySnapshot {
  readonly totalCpuMillis: number;
  readonly totalMemoryMiB: number;
  readonly reservedCpuMillis: number;
  readonly reservedMemoryMiB: number;
  readonly revision: number;
}

export interface ReservationRollbackReceipt {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly kind: "nonterminal_attachment_rollback";
  readonly reservationRevision: number;
}

export interface AllocationReleaseReceipt {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly kind: "terminal_release";
  readonly proofId: string;
  readonly terminalizationIntentId?: string;
  readonly disposition?: string;
  readonly stagingDisposition?: StagingDisposition;
  readonly participantDigests?: Readonly<Record<string, string>>;
  readonly barrierEvidenceDigest?: string;
  readonly terminalEvidenceKind?: string;
  readonly terminalEvidenceVersion?: number;
  readonly terminalEvidenceDigest?: string;
  readonly precedenceDecision?: "completion_won" | "cancellation_won";
}

export type StagingDisposition =
  | "transferred"
  | "quarantined"
  | "discarded"
  | "empty";

export interface NoAllocationReleaseReceipt {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly terminalizationIntentId: string;
  readonly kind: "terminal_no_allocation";
  readonly proofId: string;
  readonly disposition: string;
  readonly stagingDisposition: StagingDisposition;
  readonly participantDigests: Readonly<Record<string, string>>;
  readonly barrierEvidenceDigest: string;
  readonly terminalEvidenceKind: string;
  readonly terminalEvidenceVersion: number;
  readonly terminalEvidenceDigest: string;
  readonly precedenceDecision: "completion_won" | "cancellation_won";
}

export type TerminalReleaseReceipt =
  | AllocationReleaseReceipt
  | NoAllocationReleaseReceipt;

export class CapacityUnavailableError extends Error {
  public constructor() {
    super("Static capacity reservation would overcommit a hard dimension");
    this.name = "CapacityUnavailableError";
  }
}

export class StaleAllocationOwnerError extends Error {
  public constructor() {
    super("stale_owner");
    this.name = "StaleAllocationOwnerError";
  }
}

export class InvalidAllocationLeaseTransitionError extends Error {
  public constructor() {
    super("invalid_allocation_lease_transition");
    this.name = "InvalidAllocationLeaseTransitionError";
  }
}

export function claimAllocationLease(
  allocation: Allocation,
  ownerId: string,
  expectedOwnerFence: number,
  leaseUntil: number,
): Allocation {
  if (
    allocation.state === "released" ||
    allocation.leaseState !== "unowned" ||
    allocation.ownerFence !== expectedOwnerFence
  )
    throw new InvalidAllocationLeaseTransitionError();
  return Object.freeze({
    ...allocation,
    leaseOwnerId: ownerId,
    leaseState: "current",
    leaseUntil,
    ownerFence: allocation.ownerFence + 1,
    version: allocation.version + 1,
  });
}

export function renewAllocationLease(
  allocation: Allocation,
  ownerId: string,
  ownerFence: number,
  leaseUntil: number,
): Allocation {
  if (
    allocation.leaseState !== "current" ||
    allocation.leaseOwnerId !== ownerId ||
    allocation.ownerFence !== ownerFence
  )
    throw new StaleAllocationOwnerError();
  return Object.freeze({
    ...allocation,
    leaseUntil,
    version: allocation.version + 1,
  });
}

export function observeLeaseExpired(
  allocation: Allocation,
  now: number,
): Allocation {
  if (
    allocation.leaseState !== "current" ||
    allocation.leaseUntil === undefined ||
    now <= allocation.leaseUntil
  )
    throw new InvalidAllocationLeaseTransitionError();
  return Object.freeze({
    ...allocation,
    leaseState: "expired",
    version: allocation.version + 1,
  });
}

export function revokeAllocationLease(allocation: Allocation): Allocation {
  if (allocation.leaseState !== "current") {
    throw new InvalidAllocationLeaseTransitionError();
  }
  return Object.freeze({
    ...allocation,
    leaseState: "revoked",
    version: allocation.version + 1,
  });
}

export function takeOverAllocationLease(
  allocation: Allocation,
  newOwnerId: string,
  expectedOwnerFence: number,
  leaseUntil: number,
): Allocation {
  if (
    allocation.state === "released" ||
    !["expired", "revoked"].includes(allocation.leaseState) ||
    allocation.ownerFence !== expectedOwnerFence
  )
    throw new StaleAllocationOwnerError();
  return Object.freeze({
    ...allocation,
    leaseOwnerId: newOwnerId,
    leaseState: "current",
    leaseUntil,
    ownerFence: allocation.ownerFence + 1,
    version: allocation.version + 1,
  });
}

const allocationLifecycleTransitions: Readonly<
  Record<Allocation["state"], readonly Allocation["state"][]>
> = {
  reserved: Object.freeze<Allocation["state"][]>(["claimed", "releasing"]),
  claimed: Object.freeze<Allocation["state"][]>(["active", "releasing"]),
  active: Object.freeze<Allocation["state"][]>(["releasing"]),
  releasing: Object.freeze<Allocation["state"][]>(["released"]),
  released: Object.freeze<Allocation["state"][]>([]),
};

export function transitionAllocationLifecycle(
  allocation: Allocation,
  next: Allocation["state"],
  proof?: Readonly<{
    terminalizationIntentId: string;
    processQuiesced: boolean;
  }>,
): Allocation {
  if (!allocationLifecycleTransitions[allocation.state].includes(next)) {
    throw new InvalidAllocationLeaseTransitionError();
  }
  if (next === "releasing" && proof?.processQuiesced !== true) {
    throw new Error("release_before_process_quiescence");
  }
  return Object.freeze({
    ...allocation,
    state: next,
    version: allocation.version + 1,
  });
}
