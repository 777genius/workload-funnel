import { isDeepStrictEqual } from "node:util";

export interface PostgresExecutionQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresExecutionQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresExecutionQueryResult<Row>>;
}

export interface PostgresExecutionExecutor {
  read<T>(
    work: (client: PostgresExecutionQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresExecutionQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableExecution {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly executionId: string;
  readonly namespaceId: string;
  readonly ownerFence: number;
  readonly ownerId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: "starting" | "running" | "unknown" | "terminal";
  readonly version: number;
  readonly writerEpoch: number;
}

export interface FencedExecutionObservation {
  readonly executionGeneration: string;
  readonly executionId: string;
  readonly namespaceId: string;
  readonly observationDigest: string;
  readonly ownerFence: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sourceId: string;
  readonly sourceSequence: number;
  readonly state: DurableExecution["state"];
  readonly writerEpoch: number;
}

interface ExecutionRow extends Record<string, unknown> {
  readonly allocation_id: string;
  readonly attempt_id: string;
  readonly execution_generation: string;
  readonly execution_id: string;
  readonly namespace_id: string;
  readonly owner_fence: string;
  readonly owner_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: DurableExecution["state"];
  readonly version: string;
  readonly writer_epoch: string;
}

interface ObservationRow extends Record<string, unknown> {
  readonly execution_generation: string;
  readonly execution_id: string;
  readonly namespace_id: string;
  readonly observation_digest: string;
  readonly owner_fence: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source_id: string;
  readonly source_sequence: string;
  readonly state: DurableExecution["state"];
  readonly writer_epoch: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const digest = /^[a-f0-9]{64}$/u;
const columns = `execution_id, attempt_id, execution_generation, allocation_id,
  namespace_id, writer_epoch::text, owner_id, owner_fence::text, state,
  version::text, payload`;

function positive(value: string, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

function decode(row: ExecutionRow): DurableExecution {
  return Object.freeze({
    allocationId: row.allocation_id,
    attemptId: row.attempt_id,
    executionGeneration: row.execution_generation,
    executionId: row.execution_id,
    namespaceId: row.namespace_id,
    ownerFence: positive(row.owner_fence, "postgres_execution_row_corrupt"),
    ownerId: row.owner_id,
    payload: Object.freeze({ ...row.payload }),
    state: row.state,
    version: positive(row.version, "postgres_execution_row_corrupt"),
    writerEpoch: positive(row.writer_epoch, "postgres_execution_row_corrupt"),
  });
}

function sameObservation(
  row: ObservationRow,
  value: FencedExecutionObservation,
): boolean {
  return (
    row.execution_id === value.executionId &&
    row.execution_generation === value.executionGeneration &&
    row.namespace_id === value.namespaceId &&
    row.writer_epoch === String(value.writerEpoch) &&
    row.owner_fence === String(value.ownerFence) &&
    row.state === value.state &&
    row.observation_digest === value.observationDigest &&
    isDeepStrictEqual(row.payload, value.payload)
  );
}

export interface AsyncPostgresExecutionStore {
  create(
    execution: DurableExecution,
    signal?: AbortSignal,
  ): Promise<DurableExecution>;
  get(
    executionId: string,
    signal?: AbortSignal,
  ): Promise<DurableExecution | undefined>;
  recordObservation(
    observation: FencedExecutionObservation,
    signal?: AbortSignal,
  ): Promise<DurableExecution>;
  takeOwnership(
    executionId: string,
    expectedOwnerFence: number,
    nextOwnerId: string,
    nextOwnerFence: number,
    signal?: AbortSignal,
  ): Promise<DurableExecution>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresExecutionStore(
  executor: PostgresExecutionExecutor,
  schema: string,
): AsyncPostgresExecutionStore {
  if (!identifier.test(schema))
    throw new Error("postgres_execution_schema_invalid");
  const store: AsyncPostgresExecutionStore = {
    create: (execution, signal) =>
      executor.transaction(async (client) => {
        await client.query(
          `INSERT INTO ${schema}.control_execution
             (execution_id, attempt_id, execution_generation, allocation_id,
              namespace_id, writer_epoch, owner_id, owner_fence, state, version, payload)
           SELECT $1, $2, $3, a.allocation_id, n.namespace_id, $6, $7, $8,
                  $9, $10, $11::jsonb
             FROM ${schema}.control_allocation a
             JOIN ${schema}.control_namespace_ownership n
               ON n.namespace_id = $5 AND n.writer_epoch = $6
            WHERE a.allocation_id = $4
              AND a.attempt_id = $2
              AND a.execution_generation = $3
              AND a.owner_id = $7
              AND a.owner_fence = $8
              AND a.lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
              AND a.state IN ('reserved', 'active')
           ON CONFLICT (execution_id) DO NOTHING`,
          [
            execution.executionId,
            execution.attemptId,
            execution.executionGeneration,
            execution.allocationId,
            execution.namespaceId,
            execution.writerEpoch,
            execution.ownerId,
            execution.ownerFence,
            execution.state,
            execution.version,
            JSON.stringify(execution.payload),
          ],
        );
        const result = await client.query<ExecutionRow>(
          `SELECT ${columns} FROM ${schema}.control_execution
            WHERE execution_id = $1 FOR UPDATE`,
          [execution.executionId],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("postgres_execution_fence_rejected");
        const stored = decode(row);
        if (!isDeepStrictEqual(stored, execution))
          throw new Error("postgres_execution_identity_conflict");
        return stored;
      }, signal),
    get: (executionId, signal) =>
      executor.read(async (client) => {
        const result = await client.query<ExecutionRow>(
          `SELECT ${columns} FROM ${schema}.control_execution WHERE execution_id = $1`,
          [executionId],
        );
        return result.rows[0] === undefined
          ? undefined
          : decode(result.rows[0]);
      }, signal),
    recordObservation: (observation, signal) => {
      if (!digest.test(observation.observationDigest))
        return Promise.reject(new Error("postgres_observation_digest_invalid"));
      return executor.transaction(async (client) => {
        const executionResult = await client.query<ExecutionRow>(
          `SELECT ${columns} FROM ${schema}.control_execution
            WHERE execution_id = $1 FOR UPDATE`,
          [observation.executionId],
        );
        const executionRow = executionResult.rows[0];
        if (executionRow === undefined)
          throw new Error("postgres_execution_not_found");
        const execution = decode(executionRow);
        if (
          execution.executionGeneration !== observation.executionGeneration ||
          execution.namespaceId !== observation.namespaceId ||
          execution.writerEpoch !== observation.writerEpoch ||
          execution.ownerFence !== observation.ownerFence
        )
          throw new Error("postgres_observation_stale_fence");
        const allocation = await client.query<
          Record<string, unknown> & {
            execution_generation: string;
            lease_current: boolean;
            owner_fence: string;
            owner_id: string | null;
            state: string;
          }
        >(
          `SELECT execution_generation, owner_id, owner_fence::text, state,
                  lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS lease_current
             FROM ${schema}.control_allocation
            WHERE allocation_id = $1 FOR SHARE`,
          [execution.allocationId],
        );
        const allocationRow = allocation.rows[0];
        if (
          allocationRow?.execution_generation !==
            observation.executionGeneration ||
          allocationRow.owner_id !== execution.ownerId ||
          allocationRow.owner_fence !== String(observation.ownerFence) ||
          allocationRow.state === "released" ||
          !allocationRow.lease_current
        )
          throw new Error("postgres_observation_stale_allocation_fence");
        const namespace = await client.query<
          Record<string, unknown> & { writer_epoch: string }
        >(
          `SELECT writer_epoch::text
             FROM ${schema}.control_namespace_ownership
            WHERE namespace_id = $1 FOR SHARE`,
          [observation.namespaceId],
        );
        if (namespace.rows[0]?.writer_epoch !== String(observation.writerEpoch))
          throw new Error("postgres_observation_stale_writer_epoch");
        const prior = await client.query<ObservationRow>(
          `SELECT source_id, source_sequence::text, execution_id,
                  execution_generation, namespace_id, writer_epoch::text,
                  owner_fence::text, state, observation_digest, payload
             FROM ${schema}.control_observation
            WHERE source_id = $1 AND source_sequence = $2 FOR UPDATE`,
          [observation.sourceId, observation.sourceSequence],
        );
        if (prior.rows[0] !== undefined) {
          if (!sameObservation(prior.rows[0], observation))
            throw new Error("postgres_observation_idempotency_conflict");
          return execution;
        }
        await client.query(
          `INSERT INTO ${schema}.control_observation
             (source_id, source_sequence, execution_id, execution_generation,
              namespace_id, writer_epoch, owner_fence, state,
              observation_digest, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
          [
            observation.sourceId,
            observation.sourceSequence,
            observation.executionId,
            observation.executionGeneration,
            observation.namespaceId,
            observation.writerEpoch,
            observation.ownerFence,
            observation.state,
            observation.observationDigest,
            JSON.stringify(observation.payload),
          ],
        );
        const updated = await client.query<ExecutionRow>(
          `UPDATE ${schema}.control_execution
              SET state = $2, payload = $3::jsonb, version = version + 1,
                  updated_at = clock_timestamp()
            WHERE execution_id = $1 AND version = $4
           RETURNING ${columns}`,
          [
            observation.executionId,
            observation.state,
            JSON.stringify(observation.payload),
            execution.version,
          ],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_execution_version_conflict");
        return decode(updated.rows[0]);
      }, signal);
    },
    takeOwnership: (
      executionId,
      expectedOwnerFence,
      nextOwnerId,
      nextOwnerFence,
      signal,
    ) => {
      if (nextOwnerFence !== expectedOwnerFence + 1)
        return Promise.reject(
          new Error("postgres_execution_owner_fence_invalid"),
        );
      return executor.transaction(async (client) => {
        const currentResult = await client.query<ExecutionRow>(
          `SELECT ${columns} FROM ${schema}.control_execution
            WHERE execution_id = $1 FOR UPDATE`,
          [executionId],
        );
        const currentRow = currentResult.rows[0];
        if (currentRow === undefined)
          throw new Error("postgres_execution_not_found");
        const current = decode(currentRow);
        const replay =
          current.ownerId === nextOwnerId &&
          current.ownerFence === nextOwnerFence;
        if (
          !replay &&
          (current.ownerFence !== expectedOwnerFence ||
            current.state === "terminal")
        )
          throw new Error("postgres_execution_owner_fence_conflict");
        const allocation = await client.query<
          Record<string, unknown> & {
            execution_generation: string;
            lease_current: boolean;
            owner_fence: string;
            owner_id: string | null;
            state: string;
          }
        >(
          `SELECT execution_generation, owner_id, owner_fence::text, state,
                  lease_until > floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    AS lease_current
             FROM ${schema}.control_allocation
            WHERE allocation_id = $1 FOR SHARE`,
          [current.allocationId],
        );
        const allocationRow = allocation.rows[0];
        if (
          allocationRow?.execution_generation !== current.executionGeneration ||
          allocationRow.owner_id !== nextOwnerId ||
          allocationRow.owner_fence !== String(nextOwnerFence) ||
          allocationRow.state === "released" ||
          !allocationRow.lease_current
        )
          throw new Error("postgres_execution_owner_fence_conflict");
        const namespace = await client.query<
          Record<string, unknown> & { writer_epoch: string }
        >(
          `SELECT writer_epoch::text
             FROM ${schema}.control_namespace_ownership
            WHERE namespace_id = $1 FOR SHARE`,
          [current.namespaceId],
        );
        if (namespace.rows[0]?.writer_epoch !== String(current.writerEpoch))
          throw new Error("postgres_execution_stale_writer_epoch");
        if (replay) return current;
        const updated = await client.query<ExecutionRow>(
          `UPDATE ${schema}.control_execution
              SET owner_id = $2, owner_fence = $3, version = version + 1,
                  updated_at = clock_timestamp()
            WHERE execution_id = $1 AND version = $4 AND owner_fence = $5
           RETURNING ${columns}`,
          [
            executionId,
            nextOwnerId,
            nextOwnerFence,
            current.version,
            expectedOwnerFence,
          ],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_execution_owner_fence_conflict");
        return decode(updated.rows[0]);
      }, signal);
    },
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT execution_id FROM ${schema}.control_execution LIMIT 0`,
        );
        await client.query(
          `SELECT source_id FROM ${schema}.control_observation LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
