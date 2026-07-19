import { createHash } from "node:crypto";

export interface PostgresAuditQueryResult<Row extends Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresAuditQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresAuditQueryResult<Row>>;
}

export interface PostgresAuditExecutor {
  read<T>(
    work: (client: PostgresAuditQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresAuditQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableAuditRecord {
  readonly action: string;
  readonly actorId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly hash: string;
  readonly previousHash: string;
  readonly resourceId: string;
  readonly sequence: number;
  readonly tenantId: string;
}

interface AuditRow extends Record<string, unknown> {
  readonly action: string;
  readonly actor_id: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly event_id: string;
  readonly hash: string;
  readonly previous_hash: string;
  readonly resource_id: string;
  readonly sequence_id: string;
  readonly tenant_id: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const digest = /^[a-f0-9]{64}$/u;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function decode(row: AuditRow): DurableAuditRecord {
  const sequence = Number(row.sequence_id);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !digest.test(row.hash) ||
    (row.previous_hash !== "genesis" && !digest.test(row.previous_hash))
  )
    throw new Error("postgres_audit_row_corrupt");
  return Object.freeze({
    action: row.action,
    actorId: row.actor_id,
    details: Object.freeze({ ...row.details }),
    eventId: row.event_id,
    hash: row.hash,
    previousHash: row.previous_hash,
    resourceId: row.resource_id,
    sequence,
    tenantId: row.tenant_id,
  });
}

function hashRecord(input: {
  readonly action: string;
  readonly actorId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly eventId: string;
  readonly previousHash: string;
  readonly resourceId: string;
  readonly sequence: number;
  readonly tenantId: string;
}): string {
  return createHash("sha256").update(canonical(input)).digest("hex");
}

export interface AsyncPostgresAuditLedgerStore {
  append(
    input: Readonly<{
      action: string;
      actorId: string;
      details: Readonly<Record<string, unknown>>;
      eventId: string;
      resourceId: string;
      tenantId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<DurableAuditRecord>;
  page(
    tenantId: string,
    after: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DurableAuditRecord[]>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresAuditLedgerStore(
  executor: PostgresAuditExecutor,
  schema: string,
): AsyncPostgresAuditLedgerStore {
  if (!identifier.test(schema))
    throw new Error("postgres_audit_schema_invalid");
  const store: AsyncPostgresAuditLedgerStore = {
    append: (input, signal) =>
      executor.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`workload-funnel:audit:${schema}`],
        );
        const priorEvent = await client.query<AuditRow>(
          `SELECT sequence_id::text, event_id, tenant_id, actor_id, action,
                  resource_id, details, previous_hash, hash
             FROM ${schema}.control_audit WHERE event_id = $1`,
          [input.eventId],
        );
        const replay = priorEvent.rows[0];
        if (replay !== undefined) {
          const record = decode(replay);
          const expected = hashRecord({
            ...input,
            previousHash: record.previousHash,
            sequence: record.sequence,
          });
          if (record.hash !== expected)
            throw new Error("audit_event_id_conflict");
          return record;
        }
        const tail = await client.query<AuditRow>(
          `SELECT sequence_id::text, event_id, tenant_id, actor_id, action,
                  resource_id, details, previous_hash, hash
             FROM ${schema}.control_audit
            ORDER BY sequence_id DESC LIMIT 1 FOR UPDATE`,
        );
        const previous =
          tail.rows[0] === undefined ? undefined : decode(tail.rows[0]);
        const sequence = (previous?.sequence ?? 0) + 1;
        const previousHash = previous?.hash ?? "genesis";
        const hash = hashRecord({ ...input, previousHash, sequence });
        const inserted = await client.query<AuditRow>(
          `INSERT INTO ${schema}.control_audit
             (sequence_id, event_id, tenant_id, actor_id, action, resource_id,
              details, previous_hash, hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           RETURNING sequence_id::text, event_id, tenant_id, actor_id, action,
                     resource_id, details, previous_hash, hash`,
          [
            sequence,
            input.eventId,
            input.tenantId,
            input.actorId,
            input.action,
            input.resourceId,
            canonical(input.details),
            previousHash,
            hash,
          ],
        );
        const row = inserted.rows[0];
        if (row === undefined || decode(row).sequence !== sequence)
          throw new Error("postgres_audit_row_corrupt");
        return decode(row);
      }, signal),
    page: (tenantId, after, limit, signal) => {
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        return Promise.reject(new Error("postgres_audit_page_invalid"));
      return executor.read(async (client) => {
        const result = await client.query<AuditRow>(
          `SELECT sequence_id::text, event_id, tenant_id, actor_id, action,
                  resource_id, details, previous_hash, hash
             FROM ${schema}.control_audit
            WHERE tenant_id = $1 AND sequence_id > $2
            ORDER BY sequence_id LIMIT $3`,
          [tenantId, after, limit],
        );
        return Object.freeze(result.rows.map(decode));
      }, signal);
    },
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT sequence_id FROM ${schema}.control_audit LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
