import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { sha256Hex, type MutationFence } from "@workload-funnel/kernel";

import type {
  RuntimeAuthorityCloseAckV1,
  RuntimeMutationRequestV1,
  RuntimeOperationReceiptV1,
} from "../index.js";

export interface SyntheticAuthority {
  changeId: string;
  closed: boolean;
  fence: MutationFence;
  fingerprint: string;
  grantId: string;
  issuerId: string;
  registryRevision: number;
  targetId: string;
}

export interface SyntheticEvent {
  readonly causationId: string;
  readonly controllerId: string;
  readonly cursor: string;
  readonly operationId: string;
  readonly projectId: string;
  readonly runtimeBuildSha: string;
  readonly runtimeOperationId: string;
  readonly schemaVersion: "subscription-runtime.event.v1";
  readonly sourceRevision: number;
  readonly state:
    | "accepted"
    | "starting"
    | "running"
    | "exited"
    | "stopped"
    | "unknown";
  readonly targetId: string;
  readonly terminal?: Readonly<Record<string, unknown>>;
}

export interface SyntheticVersionedIdentity {
  readonly identity: string;
  readonly version: number;
}

export interface SyntheticHighWatermarks {
  cluster?: SyntheticVersionedIdentity;
  readonly allocations: Map<string, SyntheticVersionedIdentity>;
  readonly attempts: Map<string, SyntheticVersionedIdentity>;
  readonly desiredScopes: Map<string, SyntheticVersionedIdentity>;
  readonly gates: Map<string, SyntheticVersionedIdentity>;
  readonly namespaces: Map<string, SyntheticVersionedIdentity>;
  readonly nodes: Map<string, SyntheticVersionedIdentity>;
}

interface PersistedState {
  readonly authorities: readonly [string, SyntheticAuthority][];
  readonly boundaryMutationCalls: Readonly<
    Record<"runtime" | "provider" | "session", number>
  >;
  readonly closures: readonly [string, RuntimeAuthorityCloseAckV1][];
  readonly events: readonly SyntheticEvent[];
  readonly finalMutationCalls: number;
  readonly highWatermarks: {
    readonly allocations: readonly [string, SyntheticVersionedIdentity][];
    readonly attempts: readonly [string, SyntheticVersionedIdentity][];
    readonly cluster?: SyntheticVersionedIdentity;
    readonly desiredScopes: readonly [string, SyntheticVersionedIdentity][];
    readonly gates: readonly [string, SyntheticVersionedIdentity][];
    readonly namespaces: readonly [string, SyntheticVersionedIdentity][];
    readonly nodes: readonly [string, SyntheticVersionedIdentity][];
  };
  readonly latest: readonly [string, SyntheticEvent][];
  readonly receiptRequests: readonly [string, RuntimeMutationRequestV1][];
  readonly receipts: readonly [string, RuntimeOperationReceiptV1][];
  readonly registryMutations: number;
  readonly sequence: number;
}

interface StateJournalRecord {
  readonly digest: string;
  readonly previousDigest: string;
  readonly schemaVersion: "synthetic-runtime-state.v1";
  readonly sequence: number;
  readonly state: PersistedState;
}

export interface SyntheticRuntimeStorage {
  readonly authorities: Map<string, SyntheticAuthority>;
  readonly boundaryMutationCalls: Record<
    "runtime" | "provider" | "session",
    number
  >;
  readonly closures: Map<string, RuntimeAuthorityCloseAckV1>;
  readonly events: SyntheticEvent[];
  finalMutationCalls: number;
  readonly highWatermarks: SyntheticHighWatermarks;
  readonly latest: Map<string, SyntheticEvent>;
  readonly receiptRequests: Map<string, RuntimeMutationRequestV1>;
  readonly receipts: Map<string, RuntimeOperationReceiptV1>;
  registryMutations: number;
  sequence: number;
  persist(): void;
}

function emptyStorage(): SyntheticRuntimeStorage {
  return {
    authorities: new Map(),
    boundaryMutationCalls: { provider: 0, runtime: 0, session: 0 },
    closures: new Map(),
    events: [],
    finalMutationCalls: 0,
    highWatermarks: {
      allocations: new Map(),
      attempts: new Map(),
      desiredScopes: new Map(),
      gates: new Map(),
      namespaces: new Map(),
      nodes: new Map(),
    },
    latest: new Map(),
    persist: () => undefined,
    receiptRequests: new Map(),
    receipts: new Map(),
    registryMutations: 0,
    sequence: 0,
  };
}

function serialize(storage: SyntheticRuntimeStorage): PersistedState {
  return {
    authorities: [...storage.authorities],
    boundaryMutationCalls: { ...storage.boundaryMutationCalls },
    closures: [...storage.closures],
    events: [...storage.events],
    finalMutationCalls: storage.finalMutationCalls,
    highWatermarks: {
      allocations: [...storage.highWatermarks.allocations],
      attempts: [...storage.highWatermarks.attempts],
      ...(storage.highWatermarks.cluster === undefined
        ? {}
        : { cluster: storage.highWatermarks.cluster }),
      desiredScopes: [...storage.highWatermarks.desiredScopes],
      gates: [...storage.highWatermarks.gates],
      namespaces: [...storage.highWatermarks.namespaces],
      nodes: [...storage.highWatermarks.nodes],
    },
    latest: [...storage.latest],
    receiptRequests: [...storage.receiptRequests],
    receipts: [...storage.receipts],
    registryMutations: storage.registryMutations,
    sequence: storage.sequence,
  };
}

function hydrate(state: PersistedState): SyntheticRuntimeStorage {
  const storage = emptyStorage();
  for (const [key, value] of state.authorities)
    storage.authorities.set(key, value);
  Object.assign(storage.boundaryMutationCalls, state.boundaryMutationCalls);
  for (const [key, value] of state.closures) storage.closures.set(key, value);
  storage.events.push(...state.events);
  storage.finalMutationCalls = state.finalMutationCalls;
  if (state.highWatermarks.cluster !== undefined) {
    storage.highWatermarks.cluster = state.highWatermarks.cluster;
  }
  for (const field of [
    "allocations",
    "attempts",
    "desiredScopes",
    "gates",
    "namespaces",
    "nodes",
  ] as const) {
    for (const [key, value] of state.highWatermarks[field]) {
      storage.highWatermarks[field].set(key, value);
    }
  }
  for (const [key, value] of state.latest) storage.latest.set(key, value);
  for (const [key, value] of state.receiptRequests) {
    storage.receiptRequests.set(key, value);
  }
  for (const [key, value] of state.receipts) storage.receipts.set(key, value);
  storage.registryMutations = state.registryMutations;
  storage.sequence = state.sequence;
  return storage;
}

function digest(
  sequence: number,
  previousDigest: string,
  state: PersistedState,
): string {
  return sha256Hex(
    JSON.stringify([
      "synthetic-runtime-state.v1",
      sequence,
      previousDigest,
      state,
    ]),
  );
}

export function createSyntheticRuntimeStorage(
  directory?: string,
): SyntheticRuntimeStorage {
  if (directory === undefined) return emptyStorage();
  if (!isAbsolute(directory))
    throw new Error("synthetic_runtime_state_path_invalid");
  const resolved = resolve(directory);
  mkdirSync(resolved, { mode: 0o700, recursive: true });
  const directoryMetadata = lstatSync(resolved);
  if (
    !directoryMetadata.isDirectory() ||
    (directoryMetadata.mode & 0o077) !== 0
  ) {
    throw new Error("synthetic_runtime_state_directory_unsafe");
  }
  const path = join(resolved, "synthetic-runtime.wal");
  const existed = existsSync(path);
  const createFd = openSync(
    path,
    constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    fsyncSync(createFd);
  } finally {
    closeSync(createFd);
  }
  if (!existed) {
    const directoryFd = openSync(resolved, constants.O_RDONLY);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 64 << 20
  ) {
    throw new Error("synthetic_runtime_state_ledger_unsafe");
  }
  const contents = readFileSync(path, "utf8");
  if (contents.length > 0 && !contents.endsWith("\n")) {
    throw new Error("synthetic_runtime_state_truncated");
  }
  let storage = emptyStorage();
  let journalSequence = 0;
  let previousDigest = "0".repeat(64);
  for (const line of contents.length === 0
    ? []
    : contents.slice(0, -1).split("\n")) {
    const parsed = JSON.parse(line) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("synthetic_runtime_state_corrupt");
    }
    const wire = parsed as Record<string, unknown>;
    if (
      wire["schemaVersion"] !== "synthetic-runtime-state.v1" ||
      !Number.isSafeInteger(wire["sequence"]) ||
      typeof wire["previousDigest"] !== "string" ||
      typeof wire["digest"] !== "string" ||
      typeof wire["state"] !== "object" ||
      wire["state"] === null ||
      Array.isArray(wire["state"])
    ) {
      throw new Error("synthetic_runtime_state_corrupt");
    }
    const record = wire as unknown as StateJournalRecord;
    if (
      record.sequence !== journalSequence + 1 ||
      record.previousDigest !== previousDigest ||
      record.digest !==
        digest(record.sequence, record.previousDigest, record.state)
    ) {
      throw new Error("synthetic_runtime_state_corrupt");
    }
    storage = hydrate(record.state);
    journalSequence = record.sequence;
    previousDigest = record.digest;
  }
  storage.persist = () => {
    const state = serialize(storage);
    const sequence = journalSequence + 1;
    const record: StateJournalRecord = {
      digest: digest(sequence, previousDigest, state),
      previousDigest,
      schemaVersion: "synthetic-runtime-state.v1",
      sequence,
      state,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > 16 << 20) {
      throw new Error("synthetic_runtime_state_record_too_large");
    }
    const fd = openSync(
      path,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) {
        throw new Error("synthetic_runtime_state_short_append");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    journalSequence = sequence;
    previousDigest = record.digest;
  };
  return storage;
}
