export const PRESSURE_FIXTURE_READY_SCHEMA =
  "workload-funnel.production-gate.pressure-ready.v1";

export const PRESSURE_FIXTURE_CPU_WORKER_COUNT = 2;

export const PRESSURE_FIXTURE_MODES = Object.freeze([
  "cpu",
  "memory",
  "io",
  "disk",
  "inodes",
]);

const MEMORY_CHUNK_BYTES = 16 * 1024 * 1024;
const MEMORY_PRIMED_CHUNK_COUNT = 22;
const MEMORY_POST_READY_CHUNK_COUNT = 25;
export const PRESSURE_FIXTURE_MEMORY_TARGET = Object.freeze({
  chunkBytes: MEMORY_CHUNK_BYTES,
  primedChunkCount: MEMORY_PRIMED_CHUNK_COUNT,
  primedRetainedBytes: MEMORY_PRIMED_CHUNK_COUNT * MEMORY_CHUNK_BYTES,
  postReadyChunkCount: MEMORY_POST_READY_CHUNK_COUNT,
  postReadyRetainedBytes: MEMORY_POST_READY_CHUNK_COUNT * MEMORY_CHUNK_BYTES,
});

const PRIMED_STATES = Object.freeze({
  cpu: Object.freeze({
    workersOnline: PRESSURE_FIXTURE_CPU_WORKER_COUNT,
  }),
  disk: Object.freeze({ writtenBytes: 48 * 1024 * 1024 }),
  inodes: Object.freeze({ createdFiles: 3_200 }),
  io: Object.freeze({ syncedBytes: 8 * 1024 * 1024 }),
  memory: Object.freeze({
    retainedBytes: PRESSURE_FIXTURE_MEMORY_TARGET.primedRetainedBytes,
  }),
});

export async function runMemoryPressureFixture({ allocateChunk, markReady }) {
  if (typeof allocateChunk !== "function" || typeof markReady !== "function")
    throw new Error("pressure_memory_fixture_input_invalid");
  for (
    let index = 0;
    index < PRESSURE_FIXTURE_MEMORY_TARGET.primedChunkCount;
    index += 1
  )
    await allocateChunk(index, "primed");
  await markReady();
  for (
    let index = PRESSURE_FIXTURE_MEMORY_TARGET.primedChunkCount;
    index < PRESSURE_FIXTURE_MEMORY_TARGET.postReadyChunkCount;
    index += 1
  )
    await allocateChunk(index, "post-ready");
}

function exactObject(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, expectedValue]) =>
      Object.is(value[key], expectedValue),
    )
  );
}

export function pressureFixturePrimedState(mode) {
  const state = PRIMED_STATES[mode];
  if (state === undefined) throw new Error("pressure_fixture_mode_invalid");
  return state;
}

export function encodePressureFixtureReadiness(mode) {
  return `${JSON.stringify({
    mode,
    primed: pressureFixturePrimedState(mode),
    schemaVersion: PRESSURE_FIXTURE_READY_SCHEMA,
  })}\n`;
}

export function parsePressureFixtureReadiness(text, expectedMode) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("pressure_fixture_readiness_malformed");
  }
  const expectedPrimed = PRIMED_STATES[expectedMode];
  if (
    expectedPrimed === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    value.mode !== expectedMode ||
    value.schemaVersion !== PRESSURE_FIXTURE_READY_SCHEMA ||
    !exactObject(value.primed, expectedPrimed)
  )
    throw new Error("pressure_fixture_readiness_malformed");
  return Object.freeze({
    mode: value.mode,
    primed: expectedPrimed,
    schemaVersion: value.schemaVersion,
  });
}
