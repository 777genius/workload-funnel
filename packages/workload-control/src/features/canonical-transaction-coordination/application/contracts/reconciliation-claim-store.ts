export interface ReconciliationClaim {
  readonly fence: number;
  readonly leaseUntil: number;
  readonly operationId: string;
  readonly workerId: string;
}

export interface ReconciliationClaimStore {
  claim(
    operationId: string,
    workerId: string,
    leaseUntil: number,
    now: number,
    expectedClaimFence: number,
  ): ReconciliationClaim;
  assertCurrent(claim: ReconciliationClaim, now: number): void;
  renew(
    claim: ReconciliationClaim,
    leaseUntil: number,
    now: number,
  ): ReconciliationClaim;
  release(claim: ReconciliationClaim): void;
}
