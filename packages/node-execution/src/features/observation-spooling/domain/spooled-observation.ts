export interface SpooledObservation {
  readonly bootEpoch: number;
  readonly eventId: string;
  readonly executionGeneration: string;
  readonly executionId: string;
  readonly kind: "observation" | "terminal_result";
  readonly nodeId: string;
  readonly observedAtMs: number;
  readonly payloadDigest: string;
  readonly sourceSequence: number;
  readonly state: "active" | "exited" | "failed" | "stopped" | "unknown";
}

export interface ObservationPublicationAcknowledgement {
  readonly eventId: string;
  readonly publicationId: string;
}

export type ObservationSpoolCordonReason =
  | "observation_spool_corrupt"
  | "observation_spool_full";

export class ObservationSpoolError extends Error {
  public constructor(public readonly code: ObservationSpoolCordonReason) {
    super(code);
    this.name = "ObservationSpoolError";
  }
}
