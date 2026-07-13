import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { sha256Hex } from "@workload-funnel/kernel";
import type { TargetOperationObservation } from "@workload-funnel/node-execution/process-lifecycle";

import type {
  RuntimeObservationPage,
  RuntimeReconciliationStore,
} from "./application/contracts/reconciliation-store.js";

type ReconciliationMutation =
  | {
      readonly checkpoint?: string;
      readonly events: readonly TargetOperationObservation[];
      readonly kind: "event_batch";
    }
  | {
      readonly kind: "snapshot";
      readonly observation: TargetOperationObservation;
    };

interface ReconciliationJournalRecord {
  readonly digest: string;
  readonly mutation: ReconciliationMutation;
  readonly previousDigest: string;
  readonly schemaVersion: "runtime-reconciliation-store.v1";
  readonly sequence: number;
}

export interface FilesystemRuntimeReconciliationStoreConfig {
  readonly capacity: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const genesisDigest = "0".repeat(64);

function observationKey(observation: TargetOperationObservation): string {
  return `${observation.targetId}\u0000${observation.projectId}\u0000${observation.runtimeOperationId}`;
}

function assertObservation(observation: TargetOperationObservation): void {
  if (
    !identifierPattern.test(observation.targetId) ||
    !identifierPattern.test(observation.projectId) ||
    !identifierPattern.test(observation.runtimeOperationId) ||
    !identifierPattern.test(observation.operationId) ||
    !identifierPattern.test(observation.cursor) ||
    !Number.isSafeInteger(observation.sourceRevision) ||
    observation.sourceRevision < 1 ||
    ![
      "accepted",
      "starting",
      "running",
      "exited",
      "stopped",
      "unknown",
      "quarantined",
    ].includes(observation.state) ||
    (observation.state === "quarantined") !==
      (observation.quarantineReason !== undefined) ||
    (observation.state === "exited" || observation.state === "stopped") !==
      (observation.terminal !== undefined)
  ) {
    throw new Error("runtime_reconciliation_observation_invalid");
  }
}

function recordDigest(
  sequence: number,
  previousDigest: string,
  mutation: ReconciliationMutation,
): string {
  return sha256Hex(
    JSON.stringify([
      "runtime-reconciliation-store.v1",
      sequence,
      previousDigest,
      mutation,
    ]),
  );
}

function sameObservation(
  left: TargetOperationObservation,
  right: TargetOperationObservation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJournalRecord(line: string): ReconciliationJournalRecord {
  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime_reconciliation_store_corrupt");
  }
  const input = parsed as Record<string, unknown>;
  const mutation = input["mutation"];
  if (
    input["schemaVersion"] !== "runtime-reconciliation-store.v1" ||
    !Number.isSafeInteger(input["sequence"]) ||
    typeof input["previousDigest"] !== "string" ||
    typeof input["digest"] !== "string" ||
    typeof mutation !== "object" ||
    mutation === null ||
    Array.isArray(mutation)
  ) {
    throw new Error("runtime_reconciliation_store_corrupt");
  }
  const mutationInput = mutation as Record<string, unknown>;
  if (
    (mutationInput["kind"] === "event_batch" &&
      !Array.isArray(mutationInput["events"])) ||
    (mutationInput["kind"] === "snapshot" &&
      (typeof mutationInput["observation"] !== "object" ||
        mutationInput["observation"] === null ||
        Array.isArray(mutationInput["observation"]))) ||
    (mutationInput["kind"] !== "event_batch" &&
      mutationInput["kind"] !== "snapshot")
  ) {
    throw new Error("runtime_reconciliation_store_mutation_unknown");
  }
  return input as unknown as ReconciliationJournalRecord;
}

export class FilesystemRuntimeReconciliationStore implements RuntimeReconciliationStore {
  readonly #capacity: number;
  readonly #directory: string;
  readonly #filePath: string;
  readonly #maxRecordBytes: number;
  readonly #observations = new Map<string, TargetOperationObservation>();
  #checkpoint: string | undefined;
  #lastDigest = genesisDigest;
  #sequence = 0;

  public constructor(config: FilesystemRuntimeReconciliationStoreConfig) {
    const maxRecordBytes = config.maxRecordBytes ?? 8 * 1024 * 1024;
    if (
      !isAbsolute(config.directory) ||
      !Number.isSafeInteger(config.capacity) ||
      config.capacity < 1 ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 1_024
    ) {
      throw new Error("runtime_reconciliation_store_config_invalid");
    }
    this.#capacity = config.capacity;
    this.#maxRecordBytes = maxRecordBytes;
    this.#directory = resolve(config.directory);
    mkdirSync(this.#directory, { mode: 0o700, recursive: true });
    this.assertDirectory();
    this.#filePath = join(this.#directory, "runtime-reconciliation.wal");
    this.openLedger();
    this.replay();
  }

  public checkpoint(): Promise<string | undefined> {
    this.assertLedger();
    return Promise.resolve(this.#checkpoint);
  }

  public applyEventBatch(
    events: readonly TargetOperationObservation[],
    checkpoint: string | undefined,
  ): Promise<void> {
    if (events.length > 1_000) {
      throw new Error("runtime_reconciliation_event_batch_too_large");
    }
    const next = new Map(this.#observations);
    for (const event of events) this.applyObservation(next, event);
    this.append({
      ...(checkpoint === undefined ? {} : { checkpoint }),
      events: Object.freeze([...events]),
      kind: "event_batch",
    });
    this.replaceObservations(next);
    this.#checkpoint = checkpoint;
    return Promise.resolve();
  }

  public list(
    cursor: string | undefined,
    limit: number,
  ): Promise<RuntimeObservationPage> {
    this.assertLedger();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("runtime_reconciliation_store_page_size_invalid");
    }
    const after = cursor === undefined ? undefined : this.decodeCursor(cursor);
    const entries = [...this.#observations.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .filter(([key]) => after === undefined || key > after)
      .slice(0, limit + 1);
    const hasMore = entries.length > limit;
    const pageEntries = entries.slice(0, limit);
    const lastKey = pageEntries.at(-1)?.[0];
    return Promise.resolve({
      entries: Object.freeze(pageEntries.map(([, value]) => value)),
      ...(hasMore && lastKey !== undefined
        ? { nextCursor: this.encodeCursor(lastKey) }
        : {}),
    });
  }

  public saveSnapshotObservation(
    observation: TargetOperationObservation,
  ): Promise<void> {
    assertObservation(observation);
    const next = new Map(this.#observations);
    this.applyObservation(next, observation);
    this.append({ kind: "snapshot", observation });
    this.replaceObservations(next);
    return Promise.resolve();
  }

  private applyObservation(
    records: Map<string, TargetOperationObservation>,
    observation: TargetOperationObservation,
  ): void {
    assertObservation(observation);
    const key = observationKey(observation);
    const prior = records.get(key);
    if (
      prior !== undefined &&
      (observation.sourceRevision < prior.sourceRevision ||
        (observation.sourceRevision === prior.sourceRevision &&
          !sameObservation(observation, prior)) ||
        (["exited", "stopped", "quarantined"].includes(prior.state) &&
          observation.sourceRevision > prior.sourceRevision &&
          !["exited", "stopped", "quarantined"].includes(observation.state)))
    ) {
      throw new Error("runtime_reconciliation_observation_conflict");
    }
    if (prior === undefined && records.size >= this.#capacity) {
      throw new Error("runtime_reconciliation_store_capacity_exceeded");
    }
    if (
      prior === undefined ||
      observation.sourceRevision > prior.sourceRevision
    ) {
      records.set(key, observation);
    }
  }

  private append(mutation: ReconciliationMutation): void {
    const sequence = this.#sequence + 1;
    const digest = recordDigest(sequence, this.#lastDigest, mutation);
    const record: ReconciliationJournalRecord = {
      digest,
      mutation,
      previousDigest: this.#lastDigest,
      schemaVersion: "runtime-reconciliation-store.v1",
      sequence,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength - 1 > this.#maxRecordBytes) {
      throw new Error("runtime_reconciliation_store_record_too_large");
    }
    this.assertLedger();
    const fd = openSync(
      this.#filePath,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) {
        throw new Error("runtime_reconciliation_store_short_append");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#sequence = sequence;
    this.#lastDigest = digest;
  }

  private replay(): void {
    this.assertLedger();
    const metadata = lstatSync(this.#filePath);
    if (metadata.size > this.#capacity * 4 * (this.#maxRecordBytes + 1)) {
      throw new Error("runtime_reconciliation_store_size_exceeded");
    }
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return;
    if (!contents.endsWith("\n")) {
      throw new Error("runtime_reconciliation_store_truncated");
    }
    for (const line of contents.slice(0, -1).split("\n")) {
      if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes) {
        throw new Error("runtime_reconciliation_store_record_too_large");
      }
      const record = parseJournalRecord(line);
      if (
        record.sequence !== this.#sequence + 1 ||
        record.previousDigest !== this.#lastDigest ||
        record.digest !==
          recordDigest(record.sequence, record.previousDigest, record.mutation)
      ) {
        throw new Error("runtime_reconciliation_store_corrupt");
      }
      if (record.mutation.kind === "event_batch") {
        for (const event of record.mutation.events) {
          this.applyObservation(this.#observations, event);
        }
        this.#checkpoint = record.mutation.checkpoint;
      } else {
        this.applyObservation(this.#observations, record.mutation.observation);
      }
      this.#sequence = record.sequence;
      this.#lastDigest = record.digest;
    }
  }

  private replaceObservations(
    next: Map<string, TargetOperationObservation>,
  ): void {
    this.#observations.clear();
    for (const [key, value] of next) this.#observations.set(key, value);
  }

  private encodeCursor(key: string): string {
    return `store-${Buffer.from(key, "utf8").toString("base64url")}`;
  }

  private decodeCursor(cursor: string): string {
    if (!/^store-[A-Za-z0-9_-]+$/u.test(cursor)) {
      throw new Error("runtime_reconciliation_store_cursor_invalid");
    }
    return Buffer.from(cursor.slice("store-".length), "base64url").toString(
      "utf8",
    );
  }

  private openLedger(): void {
    const existed = existsSync(this.#filePath);
    const fd = openSync(
      this.#filePath,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!existed) {
      const directoryFd = openSync(this.#directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    this.assertLedger();
  }

  private assertDirectory(): void {
    const metadata = lstatSync(this.#directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(this.#directory) !== this.#directory ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("runtime_reconciliation_store_directory_unsafe");
    }
  }

  private assertLedger(): void {
    const metadata = lstatSync(this.#filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o177) !== 0
    ) {
      throw new Error("runtime_reconciliation_store_ledger_unsafe");
    }
  }
}
