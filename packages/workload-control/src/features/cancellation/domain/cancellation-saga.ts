export interface CancellationSaga {
  readonly operationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly state:
    | "requested"
    | "start_revoked"
    | "dispatch_canceled"
    | "execution_stopped"
    | "completed";
  readonly version: number;
}

export interface CancellationSagaStore {
  get(operationId: string): CancellationSaga | undefined;
  save(saga: CancellationSaga): void;
}
