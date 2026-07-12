export interface CancellationSaga {
  readonly operationId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly state:
    | "requested"
    | "start_revoked"
    | "dispatch_canceled"
    | "execution_stopped"
    | "waiting_for_authorities"
    | "barrier_closed"
    | "release_committed"
    | "completed";
  readonly startRevocationRevision?: number;
  readonly authorityEvidence?: readonly CancellationAuthorityEvidence[];
  readonly executionEvidence?: CancellationExecutionEvidence;
  readonly terminalReleaseReceiptId?: string;
  readonly version: number;
}

export type CancellationAuthorityEvidence = Readonly<{
  authorityId: string;
  revision: number;
  kind:
    | "acknowledged"
    | "independently_fenced"
    | "authorization_expired"
    | "unreachable";
  evidenceDigest: string;
}>;

export type CancellationExecutionEvidence = Readonly<{
  kind:
    | "not_submitted"
    | "superseded"
    | "stopped"
    | "exited"
    | "terminal_reconciliation"
    | "unknown";
  evidenceDigest: string;
}>;

export interface CancellationSagaStore {
  get(operationId: string): CancellationSaga | undefined;
  save(saga: CancellationSaga): void;
}

export function createCancellationSaga(
  operationId: string,
  runId: string,
  attemptId: string,
): CancellationSaga {
  return Object.freeze({
    attemptId,
    authorityEvidence: Object.freeze([]),
    operationId,
    runId,
    state: "requested",
    version: 1,
  });
}

export function recordStartRevocation(
  saga: CancellationSaga,
  revision: number,
): CancellationSaga {
  if (saga.startRevocationRevision !== undefined) {
    if (saga.startRevocationRevision !== revision) {
      throw new Error("cancellation_revocation_conflict");
    }
    return saga;
  }
  return Object.freeze({
    ...saga,
    startRevocationRevision: revision,
    state: "waiting_for_authorities",
    version: saga.version + 1,
  });
}

export function recordAuthorityEvidence(
  saga: CancellationSaga,
  evidence: CancellationAuthorityEvidence,
): CancellationSaga {
  if (saga.startRevocationRevision === undefined) {
    throw new Error("start_revocation_not_recorded");
  }
  const prior = saga.authorityEvidence?.find(
    (item) => item.authorityId === evidence.authorityId,
  );
  if (prior !== undefined) {
    if (JSON.stringify(prior) !== JSON.stringify(evidence)) {
      throw new Error("authority_evidence_conflict");
    }
    return saga;
  }
  return Object.freeze({
    ...saga,
    authorityEvidence: Object.freeze([
      ...(saga.authorityEvidence ?? []),
      Object.freeze({ ...evidence }),
    ]),
    version: saga.version + 1,
  });
}

export function recordCancellationExecutionEvidence(
  saga: CancellationSaga,
  evidence: CancellationExecutionEvidence,
): CancellationSaga {
  if (
    saga.executionEvidence !== undefined &&
    JSON.stringify(saga.executionEvidence) !== JSON.stringify(evidence)
  )
    throw new Error("execution_evidence_conflict");
  if (saga.executionEvidence !== undefined) return saga;
  return Object.freeze({
    ...saga,
    executionEvidence: Object.freeze({ ...evidence }),
    version: saga.version + 1,
  });
}

export function closeCancellationBarrier(
  saga: CancellationSaga,
  requiredAuthorityIds: readonly string[],
): CancellationSaga {
  const revision = saga.startRevocationRevision;
  if (revision === undefined) throw new Error("start_revocation_not_recorded");
  const validAuthorities = new Set(
    (saga.authorityEvidence ?? [])
      .filter(
        (item) =>
          item.kind !== "unreachable" &&
          (item.kind !== "acknowledged" || item.revision >= revision),
      )
      .map((item) => item.authorityId),
  );
  if (requiredAuthorityIds.some((id) => !validAuthorities.has(id))) {
    throw new Error("start_authority_barrier_open");
  }
  if (
    saga.executionEvidence === undefined ||
    ["unknown"].includes(saga.executionEvidence.kind)
  )
    throw new Error("execution_quiescence_barrier_open");
  return Object.freeze({
    ...saga,
    state: "barrier_closed",
    version: saga.version + 1,
  });
}

export function recordCancellationRelease(
  saga: CancellationSaga,
  receiptId: string,
): CancellationSaga {
  if (saga.state !== "barrier_closed") {
    throw new Error("release_before_quiescence");
  }
  return Object.freeze({
    ...saga,
    state: "release_committed",
    terminalReleaseReceiptId: receiptId,
    version: saga.version + 1,
  });
}
