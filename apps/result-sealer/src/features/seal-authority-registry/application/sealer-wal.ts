import { createHash, randomBytes } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import { validateSealOutputClaims } from "@workload-funnel/node-execution/result-sealing-coordination";

import type { SealerWalStorage } from "./contracts/sealer-wal-storage.js";
import type {
  RecoveredSealerWalRecord,
  SealerWalRecord,
} from "../domain/sealer-wal-record.js";

interface Envelope {
  readonly checksum: string;
  readonly previousChecksum: string;
  readonly record: SealerWalRecord;
  readonly sequence: number;
}

function checksumFor(
  sequence: number,
  previousChecksum: string,
  record: SealerWalRecord,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ previousChecksum, record, sequence }), "utf8")
    .digest("hex");
}

function validateFence(fence: MutationFence): void {
  validateMutationFence(fence);
  if (fence.desiredEffect !== "seal_output")
    throw new Error("invalid_sealer_wal_fence");
}

function validateRecord(record: SealerWalRecord): void {
  if (record.kind === "wal_initialized") {
    if (
      (record as Readonly<{ formatVersion: unknown }>).formatVersion !== 1 ||
      !/^[a-f0-9]{64}$/u.test(record.ledgerId)
    )
      throw new Error("invalid_sealer_wal_initialization");
    return;
  }
  if (record.kind === "authority_installed") {
    validateSealOutputClaims(record.authorization.claims);
    if (record.installOperationId.length === 0)
      throw new Error("invalid_sealer_install_record");
    return;
  }
  validateFence(record.mutationFence);
  if (
    record.operationId.length === 0 ||
    !/^[a-f0-9]{64}$/u.test(record.tupleFingerprint) ||
    record.mutationFenceFingerprint !==
      fingerprintMutationFence(record.mutationFence) ||
    !/^[a-f0-9]{64}$/u.test(record.treeDigest) ||
    record.outputParent.device.length === 0 ||
    record.outputParent.inode.length === 0 ||
    record.stagingParent.device.length === 0 ||
    record.stagingParent.inode.length === 0 ||
    record.sourceName.length === 0 ||
    record.destinationName.length === 0 ||
    (record.state === "receipt_persisted") !== (record.receipt !== undefined) ||
    (record.receipt !== undefined &&
      (record.receipt.operationId !== record.operationId ||
        record.receipt.tupleFingerprint !== record.tupleFingerprint ||
        record.receipt.mutationFenceFingerprint !==
          record.mutationFenceFingerprint))
  )
    throw new Error("invalid_sealer_state_record");
}

export type SealerCordonReason = "sealer_wal_corrupt" | "sealer_wal_full";

export class SealerWalError extends Error {
  public constructor(public readonly code: SealerCordonReason) {
    super(code);
    this.name = "SealerWalError";
  }
}

export class SealerWal {
  readonly #records: RecoveredSealerWalRecord[] = [];
  #cordonReason: SealerCordonReason | undefined;

  public constructor(private readonly storage: SealerWalStorage) {
    this.recover();
    if (this.#cordonReason === undefined && this.#records.length === 0) {
      if (storage.recoveryState !== "new") {
        this.#cordonReason = "sealer_wal_corrupt";
      } else {
        this.append({
          formatVersion: 1,
          kind: "wal_initialized",
          ledgerId: randomBytes(32).toString("hex"),
        });
      }
    }
  }

  public get records(): readonly RecoveredSealerWalRecord[] {
    return this.#records;
  }
  public get cordonReason(): SealerCordonReason | undefined {
    return this.#cordonReason;
  }

  public reserve(count: number): void {
    this.assertHealthy();
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      this.#records.length + count > this.storage.capacity
    ) {
      this.#cordonReason = "sealer_wal_full";
      throw new SealerWalError(this.#cordonReason);
    }
  }

  public append(record: SealerWalRecord): RecoveredSealerWalRecord {
    this.assertHealthy();
    try {
      validateRecord(record);
    } catch {
      this.#cordonReason = "sealer_wal_corrupt";
      throw new SealerWalError(this.#cordonReason);
    }
    this.reserve(1);
    const sequence = this.#records.length + 1;
    const previousChecksum = this.#records.at(-1)?.checksum ?? "0".repeat(64);
    const checksum = checksumFor(sequence, previousChecksum, record);
    try {
      this.storage.appendAndSync(
        JSON.stringify({ checksum, previousChecksum, record, sequence }),
        JSON.stringify({ checksum, sequence }),
      );
    } catch {
      this.#cordonReason = "sealer_wal_corrupt";
      throw new SealerWalError(this.#cordonReason);
    }
    const recovered = Object.freeze({
      checksum,
      previousChecksum,
      record,
      sequence,
    });
    this.#records.push(recovered);
    return recovered;
  }

  private recover(): void {
    try {
      const lines = this.storage.readAll();
      if (lines.length === 0 && this.storage.recoveryState === "existing")
        throw new Error("sealer_wal_missing_history");
      let previousChecksum = "0".repeat(64);
      for (const [index, line] of lines.entries()) {
        const value = JSON.parse(line) as Partial<Envelope>;
        const sequence = index + 1;
        if (
          value.sequence !== sequence ||
          value.previousChecksum !== previousChecksum ||
          value.record === undefined ||
          value.checksum !==
            checksumFor(sequence, previousChecksum, value.record)
        )
          throw new Error("sealer_wal_chain_mismatch");
        validateRecord(value.record);
        this.#records.push(value as RecoveredSealerWalRecord);
        previousChecksum = value.checksum;
      }
      if (
        this.#records.length > 0 &&
        this.#records[0]?.record.kind !== "wal_initialized"
      )
        throw new Error("sealer_wal_initialization_missing");
      const tail = this.#records.at(-1);
      if (
        tail !== undefined &&
        this.storage.readCommit() !==
          JSON.stringify({ checksum: tail.checksum, sequence: tail.sequence })
      )
        throw new Error("sealer_wal_commit_mismatch");
    } catch {
      this.#records.length = 0;
      this.#cordonReason = "sealer_wal_corrupt";
    }
  }

  private assertHealthy(): void {
    if (this.#cordonReason !== undefined)
      throw new SealerWalError(this.#cordonReason);
  }
}
