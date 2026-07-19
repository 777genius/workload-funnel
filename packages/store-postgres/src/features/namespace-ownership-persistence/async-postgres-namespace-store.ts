import { isDeepStrictEqual } from "node:util";

export interface PostgresNamespaceQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresNamespaceQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresNamespaceQueryResult<Row>>;
}

export interface PostgresNamespaceExecutor {
  read<T>(
    work: (client: PostgresNamespaceQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresNamespaceQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableNamespaceOwnership {
  readonly namespaceId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly writerEpoch: number;
  readonly writerId: string;
}

interface NamespaceRow extends Record<string, unknown> {
  readonly namespace_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly writer_epoch: string;
  readonly writer_id: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

function decode(row: NamespaceRow): DurableNamespaceOwnership {
  const version = Number(row.version);
  const writerEpoch = Number(row.writer_epoch);
  if (
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(writerEpoch) ||
    writerEpoch < 1
  )
    throw new Error("postgres_namespace_row_corrupt");
  return Object.freeze({
    namespaceId: row.namespace_id,
    payload: Object.freeze({ ...row.payload }),
    version,
    writerEpoch,
    writerId: row.writer_id,
  });
}

const columns =
  "namespace_id, writer_id, writer_epoch::text, version::text, payload";

export interface AsyncPostgresNamespaceOwnershipStore {
  create(
    value: DurableNamespaceOwnership,
    signal?: AbortSignal,
  ): Promise<DurableNamespaceOwnership>;
  compareAndSet(
    namespaceId: string,
    expectedVersion: number,
    expectedWriterEpoch: number,
    next: DurableNamespaceOwnership,
    signal?: AbortSignal,
  ): Promise<DurableNamespaceOwnership>;
  get(
    namespaceId: string,
    signal?: AbortSignal,
  ): Promise<DurableNamespaceOwnership | undefined>;
  assertWriter(
    namespaceId: string,
    writerId: string,
    writerEpoch: number,
    signal?: AbortSignal,
  ): Promise<void>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresNamespaceOwnershipStore(
  executor: PostgresNamespaceExecutor,
  schema: string,
): AsyncPostgresNamespaceOwnershipStore {
  if (!identifier.test(schema))
    throw new Error("postgres_namespace_schema_invalid");
  const store: AsyncPostgresNamespaceOwnershipStore = {
    create: (value, signal) =>
      executor.transaction(async (client) => {
        await client.query(
          `INSERT INTO ${schema}.control_namespace_ownership
             (namespace_id, writer_id, writer_epoch, version, payload)
           VALUES ($1, $2, $3, $4, $5::jsonb)
           ON CONFLICT (namespace_id) DO NOTHING`,
          [
            value.namespaceId,
            value.writerId,
            value.writerEpoch,
            value.version,
            JSON.stringify(value.payload),
          ],
        );
        const result = await client.query<NamespaceRow>(
          `SELECT ${columns} FROM ${schema}.control_namespace_ownership
            WHERE namespace_id = $1 FOR UPDATE`,
          [value.namespaceId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("postgres_namespace_row_corrupt");
        const stored = decode(row);
        if (!isDeepStrictEqual(stored, value))
          throw new Error("postgres_namespace_identity_conflict");
        return stored;
      }, signal),
    compareAndSet: (
      namespaceId,
      expectedVersion,
      expectedWriterEpoch,
      next,
      signal,
    ) =>
      executor.transaction(async (client) => {
        if (
          next.namespaceId !== namespaceId ||
          next.version !== expectedVersion + 1 ||
          next.writerEpoch < expectedWriterEpoch ||
          next.writerEpoch > expectedWriterEpoch + 1
        )
          throw new Error("postgres_namespace_version_conflict");
        const currentResult = await client.query<NamespaceRow>(
          `SELECT ${columns} FROM ${schema}.control_namespace_ownership
            WHERE namespace_id = $1 FOR UPDATE`,
          [namespaceId],
        );
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined)
          throw new Error("postgres_namespace_version_conflict");
        const current = decode(currentRow);
        if (
          current.version !== expectedVersion ||
          current.writerEpoch !== expectedWriterEpoch ||
          (next.writerEpoch === expectedWriterEpoch &&
            next.writerId !== current.writerId)
        )
          throw new Error("postgres_namespace_version_conflict");
        const result = await client.query<NamespaceRow>(
          `UPDATE ${schema}.control_namespace_ownership
              SET writer_id = $4, writer_epoch = $5, version = $3,
                  payload = $6::jsonb, updated_at = clock_timestamp()
            WHERE namespace_id = $1 AND version = $2 AND writer_epoch = $7
           RETURNING ${columns}`,
          [
            namespaceId,
            expectedVersion,
            next.version,
            next.writerId,
            next.writerEpoch,
            JSON.stringify(next.payload),
            expectedWriterEpoch,
          ],
        );
        if (result.rows[0] === undefined)
          throw new Error("postgres_namespace_version_conflict");
        return decode(result.rows[0]);
      }, signal),
    get: (namespaceId, signal) =>
      executor.read(async (client) => {
        const result = await client.query<NamespaceRow>(
          `SELECT ${columns} FROM ${schema}.control_namespace_ownership WHERE namespace_id = $1`,
          [namespaceId],
        );
        return result.rows[0] === undefined
          ? undefined
          : decode(result.rows[0]);
      }, signal),
    assertWriter: (namespaceId, writerId, writerEpoch, signal) =>
      executor.read(async (client) => {
        const result = await client.query(
          `SELECT 1 FROM ${schema}.control_namespace_ownership
            WHERE namespace_id = $1 AND writer_id = $2 AND writer_epoch = $3`,
          [namespaceId, writerId, writerEpoch],
        );
        if (result.rowCount !== 1)
          throw new Error("postgres_namespace_stale_writer");
      }, signal),
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT namespace_id FROM ${schema}.control_namespace_ownership LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
