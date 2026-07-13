export interface GatewayWalStorage {
  readonly capacity: number;
  appendAndSync(line: string, checkpoint: string): void;
  readAll(): readonly string[];
  readCheckpoint(): string | null;
}
