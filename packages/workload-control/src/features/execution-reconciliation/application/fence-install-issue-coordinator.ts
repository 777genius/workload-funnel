export interface PendingFenceEffect {
  readonly desiredVersion: number;
  readonly effectScopeKey: string;
  readonly installOperationId: string;
  readonly mutationFenceFingerprint: string;
}

export interface FenceInstallReceipt {
  readonly desiredVersion: number;
  readonly effectScopeKey: string;
  readonly installOperationId: string;
  readonly mutationFenceFingerprint: string;
  readonly walSequence: number;
}

export class FenceInstallIssueError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "FenceInstallIssueError";
  }
}

export class FenceInstallIssueCoordinator {
  readonly #acknowledged = new Map<string, FenceInstallReceipt>();
  readonly #pending = new Map<string, PendingFenceEffect>();

  public plan(effect: PendingFenceEffect): void {
    const current = this.#pending.get(effect.effectScopeKey);
    if (
      current !== undefined &&
      effect.desiredVersion <= current.desiredVersion
    ) {
      throw new FenceInstallIssueError("desired_version_not_monotonic");
    }
    this.#pending.set(effect.effectScopeKey, Object.freeze({ ...effect }));
    this.#acknowledged.delete(effect.effectScopeKey);
  }

  public acknowledge(receipt: FenceInstallReceipt): void {
    const pending = this.#pending.get(receipt.effectScopeKey);
    if (
      pending?.installOperationId !== receipt.installOperationId ||
      pending.mutationFenceFingerprint !== receipt.mutationFenceFingerprint ||
      pending.desiredVersion !== receipt.desiredVersion ||
      !Number.isSafeInteger(receipt.walSequence) ||
      receipt.walSequence < 1
    ) {
      throw new FenceInstallIssueError("install_receipt_mismatch");
    }
    this.#acknowledged.set(
      receipt.effectScopeKey,
      Object.freeze({ ...receipt }),
    );
  }

  public issue<T>(effectScopeKey: string, issue: () => T): T {
    const pending = this.#pending.get(effectScopeKey);
    const receipt = this.#acknowledged.get(effectScopeKey);
    if (
      pending === undefined ||
      pending.installOperationId !== receipt?.installOperationId ||
      pending.mutationFenceFingerprint !== receipt.mutationFenceFingerprint
    ) {
      throw new FenceInstallIssueError("install_ack_required_before_issue");
    }
    return issue();
  }
}
