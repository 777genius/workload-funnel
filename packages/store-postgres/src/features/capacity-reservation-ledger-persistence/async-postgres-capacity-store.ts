export interface PostgresCapacityQueryResult<
  Row extends Record<string, unknown>,
> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface PostgresCapacityQueryClient {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresCapacityQueryResult<Row>>;
}

export interface PostgresCapacityExecutor {
  read<T>(
    work: (client: PostgresCapacityQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  transaction<T>(
    work: (client: PostgresCapacityQueryClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface DurableCapacitySnapshot {
  readonly capacityId: string;
  readonly reservedCpuMillis: number;
  readonly reservedMemoryMiB: number;
  readonly revision: number;
  readonly totalCpuMillis: number;
  readonly totalMemoryMiB: number;
}

export interface DurableAllocation {
  readonly allocationId: string;
  readonly attemptId: string;
  readonly capacityId: string;
  readonly cpuMillis: number;
  readonly executionGeneration: string;
  readonly leaseUntil?: number;
  readonly memoryMiB: number;
  readonly nodeId: string;
  readonly ownerFence: number;
  readonly ownerId?: string;
  readonly state: "reserved" | "active" | "released";
  readonly version: number;
}

interface CapacityRow extends Record<string, unknown> {
  readonly capacity_id: string;
  readonly reserved_cpu_millis: string;
  readonly reserved_memory_mib: string;
  readonly revision: string;
  readonly total_cpu_millis: string;
  readonly total_memory_mib: string;
}

interface AllocationRow extends Record<string, unknown> {
  readonly allocation_id: string;
  readonly attempt_id: string;
  readonly capacity_id: string;
  readonly cpu_millis: string;
  readonly execution_generation: string;
  readonly lease_until: string | null;
  readonly memory_mib: string;
  readonly node_id: string;
  readonly owner_fence: string;
  readonly owner_id: string | null;
  readonly state: DurableAllocation["state"];
  readonly version: string;
}

const identifier = /^[a-z][a-z0-9_]{0,62}$/u;

function integer(value: string, minimum: number, code: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(code);
  return parsed;
}

function decodeCapacity(row: CapacityRow): DurableCapacitySnapshot {
  return Object.freeze({
    capacityId: row.capacity_id,
    reservedCpuMillis: integer(
      row.reserved_cpu_millis,
      0,
      "postgres_capacity_row_corrupt",
    ),
    reservedMemoryMiB: integer(
      row.reserved_memory_mib,
      0,
      "postgres_capacity_row_corrupt",
    ),
    revision: integer(row.revision, 1, "postgres_capacity_row_corrupt"),
    totalCpuMillis: integer(
      row.total_cpu_millis,
      1,
      "postgres_capacity_row_corrupt",
    ),
    totalMemoryMiB: integer(
      row.total_memory_mib,
      1,
      "postgres_capacity_row_corrupt",
    ),
  });
}

function decodeAllocation(row: AllocationRow): DurableAllocation {
  const ownerFence = integer(
    row.owner_fence,
    0,
    "postgres_allocation_row_corrupt",
  );
  if ((row.owner_id === null) !== (row.lease_until === null))
    throw new Error("postgres_allocation_row_corrupt");
  return Object.freeze({
    allocationId: row.allocation_id,
    attemptId: row.attempt_id,
    capacityId: row.capacity_id,
    cpuMillis: integer(row.cpu_millis, 1, "postgres_allocation_row_corrupt"),
    executionGeneration: row.execution_generation,
    ...(row.lease_until === null
      ? {}
      : {
          leaseUntil: integer(
            row.lease_until,
            0,
            "postgres_allocation_row_corrupt",
          ),
        }),
    memoryMiB: integer(row.memory_mib, 1, "postgres_allocation_row_corrupt"),
    nodeId: row.node_id,
    ownerFence,
    ...(row.owner_id === null ? {} : { ownerId: row.owner_id }),
    state: row.state,
    version: integer(row.version, 1, "postgres_allocation_row_corrupt"),
  });
}

const allocationColumns = `allocation_id, capacity_id, attempt_id,
  execution_generation, node_id, cpu_millis::text, memory_mib::text, state,
  owner_id, owner_fence::text, lease_until::text, version::text`;

export interface AsyncPostgresCapacityReservationStore {
  ensureProfile(
    input: Readonly<{
      capacityId: string;
      totalCpuMillis: number;
      totalMemoryMiB: number;
    }>,
    signal?: AbortSignal,
  ): Promise<DurableCapacitySnapshot>;
  reserve(
    input: Readonly<{
      allocationId: string;
      attemptId: string;
      capacityId: string;
      cpuMillis: number;
      executionGeneration: string;
      memoryMiB: number;
      nodeId: string;
    }>,
    signal?: AbortSignal,
  ): Promise<DurableAllocation>;
  activate(
    allocationId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<DurableAllocation>;
  claim(
    allocationId: string,
    ownerId: string,
    expectedOwnerFence: number,
    now: number,
    leaseUntil: number,
    signal?: AbortSignal,
  ): Promise<DurableAllocation>;
  release(
    allocationId: string,
    executionGeneration: string,
    signal?: AbortSignal,
  ): Promise<DurableAllocation>;
  snapshot(
    capacityId: string,
    signal?: AbortSignal,
  ): Promise<DurableCapacitySnapshot | undefined>;
  ready(signal?: AbortSignal): Promise<void>;
}

export function createAsyncPostgresCapacityReservationStore(
  executor: PostgresCapacityExecutor,
  schema: string,
): AsyncPostgresCapacityReservationStore {
  if (!identifier.test(schema))
    throw new Error("postgres_capacity_schema_invalid");
  const selectAllocation = (
    client: PostgresCapacityQueryClient,
    column: string,
    value: string,
    suffix = "",
  ) =>
    client.query<AllocationRow>(
      `SELECT ${allocationColumns} FROM ${schema}.control_allocation WHERE ${column} = $1 ${suffix}`,
      [value],
    );
  const store: AsyncPostgresCapacityReservationStore = {
    ensureProfile: (input, signal) =>
      executor.transaction(async (client) => {
        await client.query(
          `INSERT INTO ${schema}.control_capacity
             (capacity_id, total_cpu_millis, total_memory_mib, revision)
           VALUES ($1, $2, $3, 1) ON CONFLICT (capacity_id) DO NOTHING`,
          [input.capacityId, input.totalCpuMillis, input.totalMemoryMiB],
        );
        const result = await client.query<CapacityRow>(
          `SELECT capacity_id, total_cpu_millis::text, total_memory_mib::text,
                  reserved_cpu_millis::text, reserved_memory_mib::text, revision::text
             FROM ${schema}.control_capacity WHERE capacity_id = $1 FOR UPDATE`,
          [input.capacityId],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("postgres_capacity_row_corrupt");
        const snapshot = decodeCapacity(row);
        if (
          snapshot.totalCpuMillis !== input.totalCpuMillis ||
          snapshot.totalMemoryMiB !== input.totalMemoryMiB
        )
          throw new Error("postgres_capacity_profile_conflict");
        return snapshot;
      }, signal),
    reserve: (input, signal) =>
      executor.transaction(async (client) => {
        const priorResult = await selectAllocation(
          client,
          "attempt_id",
          input.attemptId,
          "FOR UPDATE",
        );
        const prior =
          priorResult.rows[0] === undefined
            ? undefined
            : decodeAllocation(priorResult.rows[0]);
        if (prior !== undefined) {
          if (
            prior.allocationId !== input.allocationId ||
            prior.executionGeneration !== input.executionGeneration ||
            prior.capacityId !== input.capacityId ||
            prior.nodeId !== input.nodeId ||
            prior.cpuMillis !== input.cpuMillis ||
            prior.memoryMiB !== input.memoryMiB
          )
            throw new Error("postgres_allocation_idempotency_conflict");
          return prior;
        }
        const capacityResult = await client.query<CapacityRow>(
          `SELECT capacity_id, total_cpu_millis::text, total_memory_mib::text,
                  reserved_cpu_millis::text, reserved_memory_mib::text, revision::text
             FROM ${schema}.control_capacity WHERE capacity_id = $1 FOR UPDATE`,
          [input.capacityId],
        );
        const capacityRow = capacityResult.rows[0];
        if (capacityRow === undefined)
          throw new Error("postgres_capacity_not_found");
        const capacity = decodeCapacity(capacityRow);
        if (
          capacity.reservedCpuMillis + input.cpuMillis >
            capacity.totalCpuMillis ||
          capacity.reservedMemoryMiB + input.memoryMiB > capacity.totalMemoryMiB
        )
          throw new Error("postgres_capacity_unavailable");
        const inserted = await client.query<AllocationRow>(
          `INSERT INTO ${schema}.control_allocation
             (allocation_id, capacity_id, attempt_id, execution_generation,
              node_id, cpu_millis, memory_mib, state, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', 1)
           RETURNING ${allocationColumns}`,
          [
            input.allocationId,
            input.capacityId,
            input.attemptId,
            input.executionGeneration,
            input.nodeId,
            input.cpuMillis,
            input.memoryMiB,
          ],
        );
        const updated = await client.query(
          `UPDATE ${schema}.control_capacity
              SET reserved_cpu_millis = reserved_cpu_millis + $2,
                  reserved_memory_mib = reserved_memory_mib + $3,
                  revision = revision + 1
            WHERE capacity_id = $1 AND revision = $4`,
          [
            input.capacityId,
            input.cpuMillis,
            input.memoryMiB,
            capacity.revision,
          ],
        );
        if (updated.rowCount !== 1 || inserted.rows[0] === undefined)
          throw new Error("postgres_capacity_conflict");
        return decodeAllocation(inserted.rows[0]);
      }, signal),
    activate: (allocationId, expectedVersion, signal) =>
      executor.transaction(async (client) => {
        const result = await client.query<AllocationRow>(
          `UPDATE ${schema}.control_allocation
              SET state = 'active', version = version + 1, updated_at = clock_timestamp()
            WHERE allocation_id = $1 AND version = $2 AND state = 'reserved'
           RETURNING ${allocationColumns}`,
          [allocationId, expectedVersion],
        );
        const row = result.rows[0];
        if (row === undefined)
          throw new Error("postgres_allocation_version_conflict");
        return decodeAllocation(row);
      }, signal),
    claim: (
      allocationId,
      ownerId,
      expectedOwnerFence,
      now,
      leaseUntil,
      signal,
    ) =>
      executor.transaction(async (client) => {
        if (leaseUntil <= now)
          throw new Error("postgres_allocation_lease_invalid");
        const currentResult = await selectAllocation(
          client,
          "allocation_id",
          allocationId,
          "FOR UPDATE",
        );
        const row = currentResult.rows[0];
        if (row === undefined) throw new Error("postgres_allocation_not_found");
        const current = decodeAllocation(row);
        if (
          current.ownerFence !== expectedOwnerFence ||
          (current.ownerId !== undefined &&
            current.ownerId !== ownerId &&
            (current.leaseUntil ?? 0) > now) ||
          current.state === "released"
        )
          throw new Error("postgres_allocation_owner_conflict");
        const nextFence =
          current.ownerId === ownerId && (current.leaseUntil ?? 0) > now
            ? current.ownerFence
            : current.ownerFence + 1;
        const updated = await client.query<AllocationRow>(
          `UPDATE ${schema}.control_allocation
              SET owner_id = $2, owner_fence = $3, lease_until = $4,
                  version = version + 1, updated_at = clock_timestamp()
            WHERE allocation_id = $1 AND version = $5
           RETURNING ${allocationColumns}`,
          [allocationId, ownerId, nextFence, leaseUntil, current.version],
        );
        if (updated.rows[0] === undefined)
          throw new Error("postgres_allocation_owner_conflict");
        return decodeAllocation(updated.rows[0]);
      }, signal),
    release: (allocationId, executionGeneration, signal) =>
      executor.transaction(async (client) => {
        const currentResult = await selectAllocation(
          client,
          "allocation_id",
          allocationId,
          "FOR UPDATE",
        );
        const row = currentResult.rows[0];
        if (row === undefined) throw new Error("postgres_allocation_not_found");
        const current = decodeAllocation(row);
        if (current.executionGeneration !== executionGeneration)
          throw new Error("postgres_allocation_generation_conflict");
        if (current.state === "released") return current;
        const capacity = await client.query<CapacityRow>(
          `SELECT capacity_id, total_cpu_millis::text, total_memory_mib::text,
                  reserved_cpu_millis::text, reserved_memory_mib::text, revision::text
             FROM ${schema}.control_capacity WHERE capacity_id = $1 FOR UPDATE`,
          [current.capacityId],
        );
        const capacityRow = capacity.rows[0];
        if (capacityRow === undefined)
          throw new Error("postgres_capacity_row_corrupt");
        const snapshot = decodeCapacity(capacityRow);
        const updatedCapacity = await client.query(
          `UPDATE ${schema}.control_capacity
              SET reserved_cpu_millis = reserved_cpu_millis - $2,
                  reserved_memory_mib = reserved_memory_mib - $3,
                  revision = revision + 1
            WHERE capacity_id = $1 AND revision = $4`,
          [
            current.capacityId,
            current.cpuMillis,
            current.memoryMiB,
            snapshot.revision,
          ],
        );
        const released = await client.query<AllocationRow>(
          `UPDATE ${schema}.control_allocation
              SET state = 'released', version = version + 1,
                  owner_id = NULL, lease_until = NULL, updated_at = clock_timestamp()
            WHERE allocation_id = $1 AND version = $2
           RETURNING ${allocationColumns}`,
          [allocationId, current.version],
        );
        if (updatedCapacity.rowCount !== 1 || released.rows[0] === undefined)
          throw new Error("postgres_allocation_release_conflict");
        return decodeAllocation(released.rows[0]);
      }, signal),
    snapshot: (capacityId, signal) =>
      executor.read(async (client) => {
        const result = await client.query<CapacityRow>(
          `SELECT capacity_id, total_cpu_millis::text, total_memory_mib::text,
                  reserved_cpu_millis::text, reserved_memory_mib::text, revision::text
             FROM ${schema}.control_capacity WHERE capacity_id = $1`,
          [capacityId],
        );
        return result.rows[0] === undefined
          ? undefined
          : decodeCapacity(result.rows[0]);
      }, signal),
    ready: (signal) =>
      executor.read(async (client) => {
        await client.query(
          `SELECT capacity_id FROM ${schema}.control_capacity LIMIT 0`,
        );
        await client.query(
          `SELECT allocation_id FROM ${schema}.control_allocation LIMIT 0`,
        );
      }, signal),
  };
  return Object.freeze(store);
}
