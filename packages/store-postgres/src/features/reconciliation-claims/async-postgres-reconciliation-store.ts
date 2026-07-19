import { isDeepStrictEqual } from "node:util";

export interface PostgresReconciliationQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresReconciliationQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresReconciliationQueryResult<Row>>;
}

export interface PostgresReconciliationExecutor {
  read<T>(
    work: (client: PostgresReconciliationQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresReconciliationQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableReconciliationItem {
  readonly claim?: Readonly<{
    claimantId: string;
    fence: number;
    leaseUntil: number;
  }>;
  readonly kind: string;
  readonly operationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: string;
  readonly version: number;
}

interface ReconciliationRow extends Record<string, unknown> {
  readonly claim_fence: string;
  readonly claim_lease_until: string | null;
  readonly claimant_id: string | null;
  readonly kind: string;
  readonly operation_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: string;
  readonly version: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const columns = `operation_id, kind, state, payload, version::text,
  claimant_id, claim_fence::text, claim_lease_until::text`;

function nonnegative(value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error("postgres_reconciliation_row_corrupt");
  return parsed;
}

function decode(row: ReconciliationRow): DurableReconciliationItem {
  if ((row.claimant_id === null) !== (row.claim_lease_until === null))
    throw new Error("postgres_reconciliation_row_corrupt");
  return Object.freeze({
    ...(row.claimant_id === null || row.claim_lease_until === null
      ? {}
      : {
          claim: Object.freeze({
            claimantId: row.claimant_id,
            fence: nonnegative(row.claim_fence, 1),
            leaseUntil: nonnegative(row.claim_lease_until, 0),
          }),
        }),
    kind: row.kind,
    operationId: row.operation_id,
    payload: Object.freeze({ ...row.payload }),
    state: row.state,
    version: nonnegative(row.version, 1),
  });
}

export interface AsyncPostgresReconciliationStore {
  create(
    item: DurableReconciliationItem,
    signal?: AbortSignal,
  ): Promise<DurableReconciliationItem>;
  claim(
    operationId: string,
    claimantId: string,
    expectedFence: number,
    now: number,
    leaseUntil: number,
    signal?: AbortSignal,
  ): Promise<DurableReconciliationItem>;
  compareAndSet(
    expectedVersion: number,
    next: DurableReconciliationItem,
    claim: Readonly<{ claimantId: string; fence: number }>,
    now: number,
    signal?: AbortSignal,
  ): Promise<DurableReconciliationItem>;
  listIncomplete(
    limit: number,
    signal?: AbortSignal,
  ): Promise<readonly DurableReconciliationItem[]>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresReconciliationStore(
  executor: PostgresReconciliationExecutor,
  schema: string,
): AsyncPostgresReconciliationStore {
  if (!identifier.test(schema))
    throw new Error("postgres_reconciliation_schema_invalid");
  const store: AsyncPostgresReconciliationStore = {
    create: (item, signal) =>
      executor.transaction(async (client) => {
        if (item.version !== 1 || item.claim !== undefined)
          throw new Error("postgres_reconciliation_initial_invalid");
        await client.query(
          `INSERT INTO ${schema}.control_reconciliation
             (operation_id, kind, state, payload, version)
           VALUES ($1, $2, $3, $4::jsonb, 1)
           ON CONFLICT (operation_id) DO NOTHING`,
          [
            item.operationId,
            item.kind,
            item.state,
            JSON.stringify(item.payload),
          ],
        );
        const result = await client.query<ReconciliationRow>(
          `SELECT ${columns} FROM ${schema}.control_reconciliation
            WHERE operation_id = $1 FOR UPDATE`,
          [item.operationId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("postgres_reconciliation_row_corrupt");
        const stored = decode(row);
        if (!isDeepStrictEqual(stored, item))
          throw new Error("postgres_reconciliation_identity_conflict");
        return stored;
      }, signal),
    claim: (operationId, claimantId, expectedFence, now, leaseUntil, signal) =>
      executor.transaction(async (client) => {
        if (leaseUntil <= now)
          throw new Error("postgres_reconciliation_lease_invalid");
        const result = await client.query<ReconciliationRow>(
          `SELECT ${columns} FROM ${schema}.control_reconciliation
            WHERE operation_id = $1 FOR UPDATE`,
          [operationId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("postgres_reconciliation_not_found");
        const current = decode(row);
        if (
          (current.claim?.fence ?? 0) !== expectedFence ||
          (current.claim !== undefined &&
            current.claim.claimantId !== claimantId &&
            current.claim.leaseUntil > now)
        )
          throw new Error("postgres_reconciliation_claim_conflict");
        const currentClaim = current.claim;
        const fence =
          currentClaim?.claimantId === claimantId &&
          currentClaim.leaseUntil > now
            ? currentClaim.fence
            : (currentClaim?.fence ?? 0) + 1;
        const updated = await client.query<ReconciliationRow>(
          `UPDATE ${schema}.control_reconciliation
              SET claimant_id = $2, claim_fence = $3, claim_lease_until = $4,
                  version = version + 1, updated_at = clock_timestamp()
            WHERE operation_id = $1 AND version = $5
           RETURNING ${columns}`,
          [operationId, claimantId, fence, leaseUntil, current.version],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_reconciliation_claim_conflict");
        return decode(updated.rows[0]);
      }, signal),
    compareAndSet: (expectedVersion, next, claim, now, signal) =>
      executor.transaction(async (client) => {
        if (
          next.version !== expectedVersion + 1 ||
          next.operationId.length === 0
        )
          throw new Error("postgres_reconciliation_version_conflict");
        const updated = await client.query<ReconciliationRow>(
          `UPDATE ${schema}.control_reconciliation
              SET kind = $5, state = $6, payload = $7::jsonb,
                  version = $2, updated_at = clock_timestamp()
            WHERE operation_id = $1 AND version = $3
              AND claimant_id = $4 AND claim_fence = $8
              AND claim_lease_until > $9
           RETURNING ${columns}`,
          [
            next.operationId,
            next.version,
            expectedVersion,
            claim.claimantId,
            next.kind,
            next.state,
            JSON.stringify(next.payload),
            claim.fence,
            now,
          ],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_reconciliation_stale_claim");
        return decode(updated.rows[0]);
      }, signal),
    listIncomplete: (limit, signal) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return Promise.reject(
          new Error("postgres_reconciliation_limit_invalid"),
        );
      return executor.read(async (client) => {
        const result = await client.query<ReconciliationRow>(
          `SELECT ${columns} FROM ${schema}.control_reconciliation
            WHERE state <> 'completed' ORDER BY operation_id LIMIT $1`,
          [limit],
        );
        return Object.freeze(result.rows.map(decode));
      }, signal);
    },
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT operation_id FROM ${schema}.control_reconciliation LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
