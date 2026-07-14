export class DisasterRecoveryError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "DisasterRecoveryError";
  }
}
