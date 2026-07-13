import { createHash } from "node:crypto";

import type { GatewayWalStorage } from "./contracts/gateway-wal-storage.js";
import type {
  GatewayWalRecord,
  RecoveredGatewayWalRecord,
} from "../domain/gateway-wal-record.js";

const GATEWAY_WAL_SCHEMA_VERSION = 1 as const;

function checksumFor(
  sequence: number,
  previousChecksum: string,
  record: GatewayWalRecord,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        previousChecksum,
        record,
        schemaVersion: GATEWAY_WAL_SCHEMA_VERSION,
        sequence,
      }),
      "utf8",
    )
    .digest("hex");
}

function exactRecordShape(record: unknown): record is GatewayWalRecord {
  if (typeof record !== "object" || record === null || Array.isArray(record))
    return false;
  const value = record as Readonly<{ kind?: unknown }>;
  const keysByKind: Readonly<Record<string, readonly string[]>> = {
    cli_intent: ["kind", "request", "requestFingerprint"],
    close: ["acknowledgement", "kind", "requestFingerprint"],
    effect_receipt: ["kind", "receipt", "requestFingerprint"],
    install: [
      "acknowledgement",
      "authorityHighWatermarks",
      "fence",
      "kind",
      "mutationFenceFingerprint",
      "requestFingerprint",
    ],
    reopen: [
      "installAcknowledgement",
      "kind",
      "reopenOperationId",
      "requestFingerprint",
    ],
    scope_cordoned: ["kind", "reason", "scope"],
  };
  const expected =
    typeof value.kind === "string" ? keysByKind[value.kind] : undefined;
  return (
    expected !== undefined &&
    Object.keys(record).sort().join() === [...expected].sort().join()
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export class GatewayWalError extends Error {
  public constructor(
    public readonly code:
      | "gateway_wal_corrupt"
      | "gateway_wal_full"
      | "gateway_wal_write_failed",
  ) {
    super(code);
    this.name = "GatewayWalError";
  }
}

export class GatewayWal {
  readonly #records: RecoveredGatewayWalRecord[] = [];
  #cordonReason: GatewayWalError["code"] | undefined;
  #lastChecksum = "0".repeat(64);

  public constructor(private readonly storage: GatewayWalStorage) {
    try {
      this.recover();
    } catch (error) {
      this.#cordonReason =
        error instanceof GatewayWalError ? error.code : "gateway_wal_corrupt";
    }
  }

  public get cordonReason(): GatewayWalError["code"] | undefined {
    return this.#cordonReason;
  }

  public get nextSequence(): number {
    return this.#records.length + 1;
  }

  public get records(): readonly RecoveredGatewayWalRecord[] {
    return this.#records;
  }

  public append(record: GatewayWalRecord): number {
    if (this.#cordonReason !== undefined)
      throw new GatewayWalError(this.#cordonReason);
    if (this.#records.length >= this.storage.capacity) {
      this.#cordonReason = "gateway_wal_full";
      throw new GatewayWalError("gateway_wal_full");
    }
    const sequence = this.nextSequence;
    const checksum = checksumFor(sequence, this.#lastChecksum, record);
    const envelope: RecoveredGatewayWalRecord = {
      checksum,
      previousChecksum: this.#lastChecksum,
      record,
      schemaVersion: GATEWAY_WAL_SCHEMA_VERSION,
      sequence,
    };
    try {
      this.storage.appendAndSync(
        JSON.stringify(envelope),
        JSON.stringify({
          checksum,
          sequence,
          walSchemaVersion: GATEWAY_WAL_SCHEMA_VERSION,
        }),
      );
    } catch {
      this.#cordonReason = "gateway_wal_write_failed";
      throw new GatewayWalError("gateway_wal_write_failed");
    }
    this.#records.push(deepFreeze(envelope));
    this.#lastChecksum = checksum;
    return sequence;
  }

  private recover(): void {
    let lines: readonly string[];
    try {
      lines = this.storage.readAll();
    } catch {
      throw new GatewayWalError("gateway_wal_corrupt");
    }
    if (lines.length > this.storage.capacity)
      throw new GatewayWalError("gateway_wal_full");
    for (const [index, line] of lines.entries()) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(line) as unknown;
      } catch {
        throw new GatewayWalError("gateway_wal_corrupt");
      }
      if (typeof decoded !== "object" || decoded === null)
        throw new GatewayWalError("gateway_wal_corrupt");
      const envelope = decoded as Partial<RecoveredGatewayWalRecord>;
      const sequence = index + 1;
      if (
        Object.keys(decoded).sort().join() !==
          [
            "checksum",
            "previousChecksum",
            "record",
            "schemaVersion",
            "sequence",
          ]
            .sort()
            .join() ||
        envelope.schemaVersion !== GATEWAY_WAL_SCHEMA_VERSION ||
        envelope.sequence !== sequence ||
        envelope.previousChecksum !== this.#lastChecksum ||
        !exactRecordShape(envelope.record) ||
        envelope.checksum !==
          checksumFor(sequence, this.#lastChecksum, envelope.record)
      )
        throw new GatewayWalError("gateway_wal_corrupt");
      const recovered: RecoveredGatewayWalRecord = {
        checksum: envelope.checksum,
        previousChecksum: envelope.previousChecksum,
        record: envelope.record,
        schemaVersion: GATEWAY_WAL_SCHEMA_VERSION,
        sequence,
      };
      this.#records.push(deepFreeze(recovered));
      this.#lastChecksum = envelope.checksum;
    }
    let checkpoint: unknown;
    try {
      const encodedCheckpoint = this.storage.readCheckpoint();
      checkpoint =
        encodedCheckpoint === null
          ? null
          : (JSON.parse(encodedCheckpoint) as unknown);
    } catch {
      throw new GatewayWalError("gateway_wal_corrupt");
    }
    if (this.#records.length === 0) {
      if (checkpoint !== null) throw new GatewayWalError("gateway_wal_corrupt");
      return;
    }
    if (typeof checkpoint !== "object" || checkpoint === null)
      throw new GatewayWalError("gateway_wal_corrupt");
    const value = checkpoint as Readonly<{
      checksum?: unknown;
      sequence?: unknown;
      walSchemaVersion?: unknown;
    }>;
    if (
      Object.keys(value).sort().join() !==
        "checksum,sequence,walSchemaVersion" ||
      value.walSchemaVersion !== GATEWAY_WAL_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.sequence) ||
      (value.sequence as number) < 1 ||
      (value.sequence as number) > this.#records.length ||
      this.#records[(value.sequence as number) - 1]?.checksum !== value.checksum
    )
      throw new GatewayWalError("gateway_wal_corrupt");
  }
}
