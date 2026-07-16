export type PostgresLifecycleErrorCode =
  | "postgres_lifecycle_aborted"
  | "postgres_lifecycle_closed"
  | "postgres_lifecycle_conflict"
  | "postgres_lifecycle_idempotency_conflict"
  | "postgres_lifecycle_not_found"
  | "postgres_lifecycle_operation_failed"
  | "postgres_lifecycle_outcome_unknown"
  | "postgres_lifecycle_pool_timeout"
  | "postgres_lifecycle_query_timeout"
  | "postgres_lifecycle_row_corrupt"
  | "postgres_lifecycle_shutdown_timeout"
  | "postgres_lifecycle_unavailable";

export class PostgresLifecycleError extends Error {
  public constructor(public readonly code: PostgresLifecycleErrorCode) {
    super(code);
    this.name = "PostgresLifecycleError";
  }

  public toJSON(): Readonly<{
    code: PostgresLifecycleErrorCode;
    name: string;
  }> {
    return Object.freeze({ code: this.code, name: this.name });
  }
}

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as Readonly<{ code?: unknown }>;
  return typeof candidate.code === "string" ? candidate.code : undefined;
}

export function isConnectionFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code?.startsWith("08") === true ||
    code === "57P01" ||
    code === "57P02" ||
    code === "57P03" ||
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ETIMEDOUT" ||
    error instanceof ForcedConnectionTermination
  );
}

export class ForcedConnectionTermination extends Error {
  public readonly code = "ECONNRESET";

  public constructor() {
    super("postgres_connection_terminated");
    this.name = "ForcedConnectionTermination";
  }
}

export class TransactionFailure extends Error {
  public constructor(
    public readonly original: unknown,
    public readonly commitAttempted: boolean,
    public readonly commitAcknowledged: boolean,
  ) {
    super("postgres_transaction_failed");
    this.name = "TransactionFailure";
  }
}

export function sanitizePostgresError(error: unknown): PostgresLifecycleError {
  if (error instanceof PostgresLifecycleError) return error;
  const raw = error instanceof TransactionFailure ? error.original : error;
  if (raw instanceof PostgresLifecycleError) return raw;
  const code = errorCode(raw);
  if (code === "57014")
    return new PostgresLifecycleError("postgres_lifecycle_query_timeout");
  if (isConnectionFailure(raw))
    return new PostgresLifecycleError("postgres_lifecycle_unavailable");
  return new PostgresLifecycleError("postgres_lifecycle_operation_failed");
}
