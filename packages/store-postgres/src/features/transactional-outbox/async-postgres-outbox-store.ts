export interface PostgresOutboxQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresOutboxQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresOutboxQueryResult<Row>>;
}

export interface PostgresOutboxExecutor {
  read<T>(
    work: (client: PostgresOutboxQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresOutboxQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableOutboxDelivery {
  readonly aggregateId: string;
  readonly attempts: number;
  readonly deliveryFence: number;
  readonly deliveryOwner: string;
  readonly eventType: string;
  readonly leaseUntil: number;
  readonly messageId: string;
  readonly operationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence: number;
}

interface OutboxRow extends Record<string, unknown> {
  readonly aggregate_id: string;
  readonly delivery_attempts: number;
  readonly delivery_fence: string;
  readonly delivery_lease_until: string;
  readonly delivery_owner: string;
  readonly event_type: string;
  readonly message_id: string;
  readonly operation_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sequence_id: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

function safeInteger(value: string | number, code: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(code);
  return parsed;
}

function decode(row: OutboxRow): DurableOutboxDelivery {
  return Object.freeze({
    aggregateId: row.aggregate_id,
    attempts: safeInteger(row.delivery_attempts, "postgres_outbox_row_corrupt"),
    deliveryFence: safeInteger(
      row.delivery_fence,
      "postgres_outbox_row_corrupt",
    ),
    deliveryOwner: row.delivery_owner,
    eventType: row.event_type,
    leaseUntil: safeInteger(
      row.delivery_lease_until,
      "postgres_outbox_row_corrupt",
    ),
    messageId: row.message_id,
    operationId: row.operation_id,
    payload: Object.freeze({ ...row.payload }),
    sequence: safeInteger(row.sequence_id, "postgres_outbox_row_corrupt"),
  });
}

export interface AsyncPostgresOutboxStore {
  claim(
    ownerId: string,
    now: number,
    leaseUntil: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DurableOutboxDelivery[]>;
  acknowledge(
    messageId: string,
    ownerId: string,
    deliveryFence: number,
    now: number,
    signal?: AbortSignal,
  ): Promise<void>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresOutboxStore(
  executor: PostgresOutboxExecutor,
  schema: string,
): AsyncPostgresOutboxStore {
  if (!identifier.test(schema))
    throw new Error("postgres_outbox_schema_invalid");
  const store: AsyncPostgresOutboxStore = {
    claim: (ownerId, now, leaseUntil, limit, signal) => {
      if (
        !Number.isSafeInteger(now) ||
        now < 0 ||
        !Number.isSafeInteger(leaseUntil) ||
        leaseUntil <= now ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        return Promise.reject(new Error("postgres_outbox_claim_invalid"));
      return executor.transaction(async (client) => {
        const result = await client.query<OutboxRow>(
          `WITH candidates AS (
             SELECT sequence_id
               FROM ${schema}.lifecycle_outbox
              WHERE delivered_at IS NULL
                AND (delivery_lease_until IS NULL OR delivery_lease_until <= $2)
              ORDER BY sequence_id
              FOR UPDATE SKIP LOCKED
              LIMIT $4
           )
           UPDATE ${schema}.lifecycle_outbox AS o
              SET delivery_owner = $1,
                  delivery_fence = nextval('${schema}.control_delivery_fence_seq'),
                  delivery_lease_until = $3,
                  delivery_attempts = delivery_attempts + 1
             FROM candidates
            WHERE o.sequence_id = candidates.sequence_id
           RETURNING o.sequence_id::text, o.message_id, o.operation_id,
                     o.aggregate_id, o.event_type, o.payload,
                     o.delivery_owner, o.delivery_fence::text,
                     o.delivery_lease_until::text, o.delivery_attempts`,
          [ownerId, now, leaseUntil, limit],
        );
        return Object.freeze(result.rows.map(decode));
      }, signal);
    },
    acknowledge: (messageId, ownerId, deliveryFence, now, signal) => {
      if (!Number.isSafeInteger(deliveryFence) || deliveryFence < 1)
        return Promise.reject(new Error("postgres_outbox_ack_invalid"));
      return executor.transaction(async (client) => {
        const updated = await client.query(
          `UPDATE ${schema}.lifecycle_outbox
              SET delivered_at = clock_timestamp(), delivery_lease_until = NULL
            WHERE message_id = $1
              AND delivery_owner = $2
              AND delivery_fence = $3
              AND delivered_at IS NULL
              AND delivery_lease_until > $4`,
          [messageId, ownerId, deliveryFence, now],
        );
        if (updated.rowCount === 1) return;
        const existing = await client.query<
          Record<string, unknown> & {
            delivered: boolean;
            delivery_fence: string | null;
            delivery_owner: string | null;
          }
        >(
          `SELECT delivered_at IS NOT NULL AS delivered,
                  delivery_owner, delivery_fence::text
             FROM ${schema}.lifecycle_outbox WHERE message_id = $1`,
          [messageId],
        );
        const row = existing.rows[0];
        if (
          row?.delivered === true &&
          row.delivery_owner === ownerId &&
          row.delivery_fence === String(deliveryFence)
        )
          return;
        throw new Error("postgres_outbox_stale_delivery_fence");
      }, signal);
    },
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT sequence_id FROM ${schema}.lifecycle_outbox LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
