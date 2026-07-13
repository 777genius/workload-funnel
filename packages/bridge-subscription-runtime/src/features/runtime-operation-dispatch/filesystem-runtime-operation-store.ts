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
import type { TargetOperationReceipt } from "@workload-funnel/node-execution/process-lifecycle";

import type {
  DurableRuntimeOperation,
  RuntimeOperationStore,
} from "./application/contracts/runtime-operation-store.js";

interface OperationJournalRecord {
  readonly digest: string;
  readonly operation: DurableRuntimeOperation;
  readonly previousDigest: string;
  readonly schemaVersion: "runtime-operation-store.v1";
  readonly sequence: number;
}

export interface FilesystemRuntimeOperationStoreConfig {
  readonly capacity: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const fingerprintPattern = /^fence-v1-[a-f0-9]{64}$/u;
const genesisDigest = "0".repeat(64);

function recordDigest(
  sequence: number,
  previousDigest: string,
  operation: DurableRuntimeOperation,
): string {
  return sha256Hex(
    JSON.stringify([
      "runtime-operation-store.v1",
      sequence,
      previousDigest,
      operation,
    ]),
  );
}

function assertReceipt(
  receipt: TargetOperationReceipt,
  operation: DurableRuntimeOperation,
): void {
  if (
    receipt.operationId !== operation.operationId ||
    receipt.mutationFenceFingerprint !== operation.mutationFenceFingerprint ||
    !["accepted", "running", "completed", "rejected", "unknown"].includes(
      receipt.state,
    )
  ) {
    throw new Error("runtime_operation_store_receipt_invalid");
  }
}

function assertOperation(operation: DurableRuntimeOperation): void {
  if (
    !["runtime", "provider", "session"].includes(operation.boundary) ||
    !["pending", "recorded", "unknown"].includes(operation.state) ||
    !identifierPattern.test(operation.idempotencyKey) ||
    !identifierPattern.test(operation.operationId) ||
    !identifierPattern.test(operation.runtimeTargetId) ||
    operation.intentFingerprint.length < 32 ||
    !fingerprintPattern.test(operation.mutationFenceFingerprint) ||
    (operation.state === "recorded") !== (operation.receipt !== undefined)
  ) {
    throw new Error("runtime_operation_store_record_invalid");
  }
  if (operation.receipt !== undefined)
    assertReceipt(operation.receipt, operation);
}

function exactOperation(
  left: DurableRuntimeOperation,
  right: DurableRuntimeOperation,
): boolean {
  return (
    left.boundary === right.boundary &&
    left.idempotencyKey === right.idempotencyKey &&
    left.intentFingerprint === right.intentFingerprint &&
    left.mutationFenceFingerprint === right.mutationFenceFingerprint &&
    left.operationId === right.operationId &&
    left.runtimeTargetId === right.runtimeTargetId
  );
}

function parseJournalRecord(line: string): OperationJournalRecord {
  const parsed = JSON.parse(line) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime_operation_store_corrupt");
  }
  const input = parsed as Record<string, unknown>;
  if (
    input["schemaVersion"] !== "runtime-operation-store.v1" ||
    !Number.isSafeInteger(input["sequence"]) ||
    typeof input["previousDigest"] !== "string" ||
    typeof input["digest"] !== "string" ||
    typeof input["operation"] !== "object" ||
    input["operation"] === null ||
    Array.isArray(input["operation"])
  ) {
    throw new Error("runtime_operation_store_corrupt");
  }
  const record = input as unknown as OperationJournalRecord;
  assertOperation(record.operation);
  return record;
}

export class FilesystemRuntimeOperationStore implements RuntimeOperationStore {
  readonly #capacity: number;
  readonly #directory: string;
  readonly #filePath: string;
  readonly #maxRecordBytes: number;
  readonly #records = new Map<string, DurableRuntimeOperation>();
  #lastDigest = genesisDigest;
  #sequence = 0;

  public constructor(config: FilesystemRuntimeOperationStoreConfig) {
    const maxRecordBytes = config.maxRecordBytes ?? 64 * 1024;
    if (
      !isAbsolute(config.directory) ||
      !Number.isSafeInteger(config.capacity) ||
      config.capacity < 1 ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 1_024
    ) {
      throw new Error("runtime_operation_store_config_invalid");
    }
    this.#capacity = config.capacity;
    this.#maxRecordBytes = maxRecordBytes;
    this.#directory = resolve(config.directory);
    mkdirSync(this.#directory, { mode: 0o700, recursive: true });
    this.assertDirectory();
    this.#filePath = join(this.#directory, "runtime-operations.wal");
    this.openLedger();
    this.replay();
  }

  public find(
    idempotencyKey: string,
  ): Promise<DurableRuntimeOperation | undefined> {
    this.assertLedger();
    return Promise.resolve(this.#records.get(idempotencyKey));
  }

  public reserve(
    operation: DurableRuntimeOperation,
  ): Promise<DurableRuntimeOperation> {
    assertOperation(operation);
    const prior = this.#records.get(operation.idempotencyKey);
    if (prior !== undefined) return Promise.resolve(prior);
    if (this.#records.size >= this.#capacity) {
      throw new Error("runtime_operation_store_capacity_exceeded");
    }
    this.append(operation);
    return Promise.resolve(operation);
  }

  public save(
    operation: DurableRuntimeOperation,
    receipt: TargetOperationReceipt,
  ): Promise<DurableRuntimeOperation> {
    const current = this.currentExact(operation);
    assertReceipt(receipt, current);
    if (current.receipt !== undefined) return Promise.resolve(current);
    const recorded = Object.freeze({
      ...current,
      receipt: Object.freeze({ ...receipt }),
      state: "recorded" as const,
    });
    this.append(recorded);
    return Promise.resolve(recorded);
  }

  public saveUnknown(
    operation: DurableRuntimeOperation,
  ): Promise<DurableRuntimeOperation> {
    const current = this.currentExact(operation);
    if (current.receipt !== undefined || current.state === "unknown") {
      return Promise.resolve(current);
    }
    const unknown = Object.freeze({ ...current, state: "unknown" as const });
    this.append(unknown);
    return Promise.resolve(unknown);
  }

  private append(operation: DurableRuntimeOperation): void {
    assertOperation(operation);
    const sequence = this.#sequence + 1;
    const digest = recordDigest(sequence, this.#lastDigest, operation);
    const record: OperationJournalRecord = {
      digest,
      operation,
      previousDigest: this.#lastDigest,
      schemaVersion: "runtime-operation-store.v1",
      sequence,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength - 1 > this.#maxRecordBytes) {
      throw new Error("runtime_operation_store_record_too_large");
    }
    this.assertLedger();
    const fd = openSync(
      this.#filePath,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) {
        throw new Error("runtime_operation_store_short_append");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#sequence = sequence;
    this.#lastDigest = digest;
    this.#records.set(operation.idempotencyKey, operation);
  }

  private currentExact(
    operation: DurableRuntimeOperation,
  ): DurableRuntimeOperation {
    const current = this.#records.get(operation.idempotencyKey);
    if (current === undefined || !exactOperation(current, operation)) {
      throw new Error("runtime_operation_store_identity_conflict");
    }
    return current;
  }

  private replay(): void {
    this.assertLedger();
    const metadata = lstatSync(this.#filePath);
    if (metadata.size > this.#capacity * 3 * (this.#maxRecordBytes + 1)) {
      throw new Error("runtime_operation_store_size_exceeded");
    }
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return;
    if (!contents.endsWith("\n")) {
      throw new Error("runtime_operation_store_truncated");
    }
    const lines = contents.slice(0, -1).split("\n");
    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes) {
        throw new Error("runtime_operation_store_record_too_large");
      }
      const record = parseJournalRecord(line);
      if (
        record.sequence !== this.#sequence + 1 ||
        record.previousDigest !== this.#lastDigest ||
        record.digest !==
          recordDigest(record.sequence, record.previousDigest, record.operation)
      ) {
        throw new Error("runtime_operation_store_corrupt");
      }
      const prior = this.#records.get(record.operation.idempotencyKey);
      if (prior !== undefined && !exactOperation(prior, record.operation)) {
        throw new Error("runtime_operation_store_identity_conflict");
      }
      this.#sequence = record.sequence;
      this.#lastDigest = record.digest;
      this.#records.set(record.operation.idempotencyKey, record.operation);
    }
    if (this.#records.size > this.#capacity) {
      throw new Error("runtime_operation_store_capacity_exceeded");
    }
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
      throw new Error("runtime_operation_store_directory_unsafe");
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
      throw new Error("runtime_operation_store_ledger_unsafe");
    }
  }
}
