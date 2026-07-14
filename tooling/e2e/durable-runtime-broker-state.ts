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

import type {
  RuntimeAuthorityCloseAckV1,
  RuntimeMutationRequestV1,
  RuntimeOperationReceiptV1,
} from "@workload-funnel/bridge-subscription-runtime/runtime-operation-dispatch";
import { sha256Hex } from "@workload-funnel/kernel";
import type { TargetCanonicalAuthorityGrant } from "@workload-funnel/node-execution/process-lifecycle";

export interface DurableRuntimeAuthority {
  readonly grant: TargetCanonicalAuthorityGrant;
  readonly open: boolean;
  readonly registryRevision: number;
}

export interface DurableRuntimeBrokerState {
  readonly authorities: Map<string, DurableRuntimeAuthority>;
  readonly closures: Map<string, RuntimeAuthorityCloseAckV1>;
  finalMutationAttempts: number;
  readonly receipts: Map<
    string,
    Readonly<{
      request: RuntimeMutationRequestV1;
      receipt: RuntimeOperationReceiptV1;
    }>
  >;
  registryRevision: number;
}

interface StateWire {
  readonly authorities: readonly [string, DurableRuntimeAuthority][];
  readonly closures: readonly [string, RuntimeAuthorityCloseAckV1][];
  readonly finalMutationAttempts: number;
  readonly receipts: readonly [
    string,
    Readonly<{
      request: RuntimeMutationRequestV1;
      receipt: RuntimeOperationReceiptV1;
    }>,
  ][];
  readonly registryRevision: number;
}

interface JournalRecord {
  readonly digest: string;
  readonly previousDigest: string;
  readonly schemaVersion: string;
  readonly sequence: number;
  readonly state: StateWire;
}

function emptyState(): DurableRuntimeBrokerState {
  return {
    authorities: new Map(),
    closures: new Map(),
    finalMutationAttempts: 0,
    receipts: new Map(),
    registryRevision: 0,
  };
}

function wire(state: DurableRuntimeBrokerState): StateWire {
  return {
    authorities: [...state.authorities],
    closures: [...state.closures],
    finalMutationAttempts: state.finalMutationAttempts,
    receipts: [...state.receipts],
    registryRevision: state.registryRevision,
  };
}

function hydrate(value: StateWire): DurableRuntimeBrokerState {
  return {
    authorities: new Map(value.authorities),
    closures: new Map(value.closures),
    finalMutationAttempts: value.finalMutationAttempts,
    receipts: new Map(value.receipts),
    registryRevision: value.registryRevision,
  };
}

function digest(
  sequence: number,
  previousDigest: string,
  state: StateWire,
): string {
  return sha256Hex(
    JSON.stringify([
      "full-lifecycle-runtime-broker.v1",
      sequence,
      previousDigest,
      state,
    ]),
  );
}

export class DurableRuntimeBrokerStorage {
  public readonly state: DurableRuntimeBrokerState;
  readonly #directory: string;
  readonly #path: string;
  #previousDigest = "0".repeat(64);
  #sequence = 0;

  public constructor(directory: string) {
    if (!isAbsolute(directory)) throw new Error("runtime_broker_path_invalid");
    this.#directory = resolve(directory);
    mkdirSync(this.#directory, { mode: 0o700, recursive: true });
    const directoryMetadata = lstatSync(this.#directory);
    if (
      !directoryMetadata.isDirectory() ||
      (directoryMetadata.mode & 0o077) !== 0
    ) {
      throw new Error("runtime_broker_directory_unsafe");
    }
    this.#path = join(this.#directory, "runtime-broker.wal");
    const existed = existsSync(this.#path);
    const fd = openSync(
      this.#path,
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
    const recovered = this.replay();
    this.state = recovered;
  }

  public persist(): void {
    const state = wire(this.state);
    const sequence = this.#sequence + 1;
    const record: JournalRecord = {
      digest: digest(sequence, this.#previousDigest, state),
      previousDigest: this.#previousDigest,
      schemaVersion: "full-lifecycle-runtime-broker.v1",
      sequence,
      state,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength > 4 << 20) {
      throw new Error("runtime_broker_record_too_large");
    }
    const fd = openSync(
      this.#path,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength) {
        throw new Error("runtime_broker_short_append");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#sequence = sequence;
    this.#previousDigest = record.digest;
  }

  private replay(): DurableRuntimeBrokerState {
    const metadata = lstatSync(this.#path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 64 << 20
    ) {
      throw new Error("runtime_broker_ledger_unsafe");
    }
    const contents = readFileSync(this.#path, "utf8");
    if (contents.length === 0) return emptyState();
    if (!contents.endsWith("\n")) throw new Error("runtime_broker_truncated");
    let recovered = emptyState();
    for (const line of contents.slice(0, -1).split("\n")) {
      const record = JSON.parse(line) as JournalRecord;
      if (
        record.schemaVersion !== "full-lifecycle-runtime-broker.v1" ||
        record.sequence !== this.#sequence + 1 ||
        record.previousDigest !== this.#previousDigest ||
        record.digest !==
          digest(record.sequence, record.previousDigest, record.state)
      ) {
        throw new Error("runtime_broker_corrupt");
      }
      recovered = hydrate(record.state);
      this.#sequence = record.sequence;
      this.#previousDigest = record.digest;
    }
    return recovered;
  }
}
