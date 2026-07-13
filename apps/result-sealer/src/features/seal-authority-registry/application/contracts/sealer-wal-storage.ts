export interface SealerWalStorage {
  readonly capacity: number;
  readonly recoveryState: "new" | "existing";
  appendAndSync(serializedRecord: string, commit: string): void;
  readCommit(): string | undefined;
  readAll(): readonly string[];
}
