export interface ObservationSpoolStorage {
  readonly capacity: number;
  appendAndSync(serializedRecord: string): void;
  readAll(): readonly string[];
}
