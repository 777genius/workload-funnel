export interface ResultEntry {
  readonly path: string;
  readonly checksum: string;
  readonly sizeBytes: number;
  readonly location: string;
}

export interface ResultManifest {
  readonly resultManifestId: string;
  readonly attemptId: string;
  readonly executionId?: string;
  readonly entries: readonly ResultEntry[];
  readonly complete: boolean;
  readonly retentionClass: "synthetic-ephemeral";
  readonly version: number;
}

export class IncompleteResultManifestError extends Error {
  public constructor() {
    super("Attempt success requires a complete ResultManifest");
    this.name = "IncompleteResultManifestError";
  }
}
