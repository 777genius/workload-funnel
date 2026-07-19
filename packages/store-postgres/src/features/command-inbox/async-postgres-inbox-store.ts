export interface PostgresInboxQueryResult<Row extends Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresInboxQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresInboxQueryResult<Row>>;
}

export interface PostgresInboxExecutor {
  read<T>(
    work: (client: PostgresInboxQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresInboxQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableInboxReceipt {
  readonly consumerId: string;
  readonly messageId: string;
  readonly operationKind: string;
  readonly payloadDigest: string;
}

interface InboxRow extends Record<string, unknown> {
  readonly consumer_id: string;
  readonly message_id: string;
  readonly operation_kind: string;
  readonly payload_digest: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const digest = /^[a-f0-9]{64}$/u;

function decode(row: InboxRow): DurableInboxReceipt {
  if (!digest.test(row.payload_digest))
    throw new Error("postgres_inbox_row_corrupt");
  return Object.freeze({
    consumerId: row.consumer_id,
    messageId: row.message_id,
    operationKind: row.operation_kind,
    payloadDigest: row.payload_digest,
  });
}

export interface AsyncPostgresInboxStore {
  complete(
    receipt: DurableInboxReceipt,
    signal?: AbortSignal,
  ): Promise<DurableInboxReceipt>;
  get(
    consumerId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<DurableInboxReceipt | undefined>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresInboxStore(
  executor: PostgresInboxExecutor,
  schema: string,
): AsyncPostgresInboxStore {
  if (!identifier.test(schema))
    throw new Error("postgres_inbox_schema_invalid");
  const store: AsyncPostgresInboxStore = {
    complete: (receipt, signal) => {
      if (!digest.test(receipt.payloadDigest))
        return Promise.reject(new Error("postgres_inbox_digest_invalid"));
      return executor.transaction(async (client) => {
        await client.query(
          `INSERT INTO ${schema}.control_inbox
             (consumer_id, message_id, operation_kind, payload_digest)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (consumer_id, message_id) DO NOTHING`,
          [
            receipt.consumerId,
            receipt.messageId,
            receipt.operationKind,
            receipt.payloadDigest,
          ],
        );
        const result = await client.query<InboxRow>(
          `SELECT consumer_id, message_id, operation_kind, payload_digest
             FROM ${schema}.control_inbox
            WHERE consumer_id = $1 AND message_id = $2 FOR UPDATE`,
          [receipt.consumerId, receipt.messageId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("postgres_inbox_row_corrupt");
        const stored = decode(row);
        if (
          stored.operationKind !== receipt.operationKind ||
          stored.payloadDigest !== receipt.payloadDigest
        )
          throw new Error("postgres_inbox_idempotency_conflict");
        return stored;
      }, signal);
    },
    get: (consumerId, messageId, signal) =>
      executor.read(async (client) => {
        const result = await client.query<InboxRow>(
          `SELECT consumer_id, message_id, operation_kind, payload_digest
             FROM ${schema}.control_inbox
            WHERE consumer_id = $1 AND message_id = $2`,
          [consumerId, messageId],
        );
        return result.rows[0] === undefined
          ? undefined
          : decode(result.rows[0]);
      }, signal),
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT consumer_id FROM ${schema}.control_inbox LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
