import { isDeepStrictEqual } from "node:util";

export interface PostgresNodeQueryResult<Row extends Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresNodeQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresNodeQueryResult<Row>>;
}

export interface PostgresNodeExecutor {
  read<T>(
    work: (client: PostgresNodeQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresNodeQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableNodeObservation {
  readonly bootEpoch: string;
  readonly nodeId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly sourceSequence: number;
  readonly version: number;
}

interface NodeRow extends Record<string, unknown> {
  readonly boot_epoch: string;
  readonly node_id: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly source_sequence: string;
  readonly version: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;
const columns =
  "node_id, boot_epoch, source_sequence::text, version::text, payload";

function decode(row: NodeRow): DurableNodeObservation {
  const sourceSequence = Number(row.source_sequence);
  const version = Number(row.version);
  if (
    !Number.isSafeInteger(sourceSequence) ||
    sourceSequence < 1 ||
    !Number.isSafeInteger(version) ||
    version < 1
  )
    throw new Error("postgres_node_row_corrupt");
  return Object.freeze({
    bootEpoch: row.boot_epoch,
    nodeId: row.node_id,
    payload: Object.freeze({ ...row.payload }),
    sourceSequence,
    version,
  });
}

export interface AsyncPostgresNodeObservationStore {
  record(
    observation: DurableNodeObservation,
    signal?: AbortSignal,
  ): Promise<DurableNodeObservation>;
  get(
    nodeId: string,
    signal?: AbortSignal,
  ): Promise<DurableNodeObservation | undefined>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresNodeObservationStore(
  executor: PostgresNodeExecutor,
  schema: string,
): AsyncPostgresNodeObservationStore {
  if (!identifier.test(schema)) throw new Error("postgres_node_schema_invalid");
  const store: AsyncPostgresNodeObservationStore = {
    record: (observation, signal) =>
      executor.transaction(async (client) => {
        const priorResult = await client.query<NodeRow>(
          `SELECT ${columns} FROM ${schema}.control_node_snapshot
            WHERE node_id = $1 FOR UPDATE`,
          [observation.nodeId],
        );
        const prior =
          priorResult.rows[0] === undefined
            ? undefined
            : decode(priorResult.rows[0]);
        if (prior === undefined) {
          if (observation.version !== 1 || observation.sourceSequence !== 1)
            throw new Error("postgres_node_initial_sequence_invalid");
          const inserted = await client.query<NodeRow>(
            `INSERT INTO ${schema}.control_node_snapshot
               (node_id, boot_epoch, source_sequence, version, payload)
             VALUES ($1, $2, $3, 1, $4::jsonb)
             RETURNING ${columns}`,
            [
              observation.nodeId,
              observation.bootEpoch,
              observation.sourceSequence,
              JSON.stringify(observation.payload),
            ],
          );
          if (inserted.rows[0] === undefined)
            throw new Error("postgres_node_row_corrupt");
          return decode(inserted.rows[0]);
        }
        if (
          prior.bootEpoch === observation.bootEpoch &&
          prior.sourceSequence === observation.sourceSequence
        ) {
          if (
            prior.version !== observation.version ||
            !isDeepStrictEqual(prior.payload, observation.payload)
          )
            throw new Error("postgres_node_observation_conflict");
          return prior;
        }
        const bootChanged = prior.bootEpoch !== observation.bootEpoch;
        if (
          observation.version !== prior.version + 1 ||
          (bootChanged
            ? observation.sourceSequence !== 1
            : observation.sourceSequence !== prior.sourceSequence + 1)
        )
          throw new Error("postgres_node_source_sequence_conflict");
        const updated = await client.query<NodeRow>(
          `UPDATE ${schema}.control_node_snapshot
              SET boot_epoch = $2, source_sequence = $3, version = $4,
                  payload = $5::jsonb, observed_at = clock_timestamp()
            WHERE node_id = $1 AND version = $6
           RETURNING ${columns}`,
          [
            observation.nodeId,
            observation.bootEpoch,
            observation.sourceSequence,
            observation.version,
            JSON.stringify(observation.payload),
            prior.version,
          ],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_node_version_conflict");
        return decode(updated.rows[0]);
      }, signal),
    get: (nodeId, signal) =>
      executor.read(async (client) => {
        const result = await client.query<NodeRow>(
          `SELECT ${columns} FROM ${schema}.control_node_snapshot WHERE node_id = $1`,
          [nodeId],
        );
        return result.rows[0] === undefined
          ? undefined
          : decode(result.rows[0]);
      }, signal),
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT node_id FROM ${schema}.control_node_snapshot LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
