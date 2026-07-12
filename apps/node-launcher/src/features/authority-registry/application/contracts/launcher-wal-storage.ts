export interface LauncherWalStorage {
  readonly capacity: number;
  appendAndSync(serializedRecord: string): void;
  readAll(): readonly string[];
}
