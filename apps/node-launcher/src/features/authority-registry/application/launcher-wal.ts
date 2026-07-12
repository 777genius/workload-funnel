import { createHash } from "node:crypto";

import {
  fingerprintMutationFence,
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

import type { LauncherWalStorage } from "./contracts/launcher-wal-storage.js";
import type {
  LauncherWalRecord,
  RecoveredLauncherWalRecord,
} from "../domain/launcher-wal-record.js";

interface WalEnvelope {
  readonly checksum: string;
  readonly previousChecksum: string;
  readonly record: LauncherWalRecord;
  readonly sequence: number;
}

interface UntrustedWalEnvelope {
  readonly checksum?: unknown;
  readonly previousChecksum?: unknown;
  readonly record?: unknown;
  readonly sequence?: unknown;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isProcessStop(value: string): boolean {
  return value === "process_stop";
}

function hasCanonicalFingerprint(
  fence: MutationFence,
  fingerprint: string,
): boolean {
  return fingerprintMutationFence(fence) === fingerprint;
}

function isValidMutationFence(fence: MutationFence): boolean {
  try {
    validateMutationFence(fence);
    return true;
  } catch {
    return false;
  }
}

function validateWalRecord(record: LauncherWalRecord): void {
  if (record.kind === "authority_installed") {
    if (!validText(record.operationId) || typeof record.snapshot !== "object") {
      throw new Error("incomplete authority WAL record");
    }
    return;
  }
  if (record.kind === "start_state") {
    if (
      !validText(record.attemptId) ||
      !Number.isSafeInteger(record.authorityWalSequence) ||
      record.authorityWalSequence < 1 ||
      !validText(record.clusterIncarnation) ||
      !Number.isSafeInteger(record.executionDeadlineMs) ||
      record.executionDeadlineMs < 1 ||
      !validText(record.executionGeneration) ||
      !validText(record.issuerKeyId) ||
      !validText(record.nonce) ||
      !validText(record.operationId) ||
      !validText(record.ticketDigest) ||
      !validText(record.unitName) ||
      !Number.isSafeInteger(record.nodeBootEpoch) ||
      record.nodeBootEpoch < 0 ||
      !validText(record.nodeBootId) ||
      !validText(record.nodeId) ||
      ![
        "continue_until_deadline",
        "executor_fenced",
        "terminate_after_grace",
      ].includes(record.partitionPolicy) ||
      !["redeemed", "systemd_call_issued", "started_or_unknown"].includes(
        record.state,
      ) ||
      !hasCanonicalFingerprint(
        record.mutationFence,
        record.mutationFenceFingerprint,
      ) ||
      record.mutationFence.attemptId !== record.attemptId ||
      record.mutationFence.executionGeneration !== record.executionGeneration ||
      record.mutationFence.nodeId !== record.nodeId ||
      record.mutationFence.nodeBootEpoch !== record.nodeBootEpoch ||
      record.mutationFence.notAfter !== record.executionDeadlineMs ||
      record.mutationFence.desiredEffect !== "process_start"
    ) {
      throw new Error("incomplete start WAL record");
    }
    return;
  }
  if (record.kind === "control_partition") {
    if (
      !validText(record.attemptId) ||
      !Number.isSafeInteger(record.disconnectedAtMs) ||
      record.disconnectedAtMs < 0 ||
      !validText(record.executionGeneration) ||
      !/^fence-v1-[a-f0-9]{64}$/u.test(record.mutationFenceFingerprint) ||
      !Number.isSafeInteger(record.nodeBootEpoch) ||
      record.nodeBootEpoch < 0 ||
      !validText(record.nodeBootId) ||
      !validText(record.nodeId) ||
      ![
        "continue_until_deadline",
        "executor_fenced",
        "terminate_after_grace",
      ].includes(record.partitionPolicy) ||
      !["scheduled", "stop_issued", "stopped_or_unknown"].includes(
        record.state,
      ) ||
      !Number.isSafeInteger(record.stopAtMs) ||
      record.stopAtMs < record.disconnectedAtMs ||
      !validText(record.unitName)
    ) {
      throw new Error("incomplete control-partition WAL record");
    }
    return;
  }
  if (record.kind === "effect_state") {
    if (
      !isProcessStop(record.effect) ||
      !validText(record.operationId) ||
      !validText(record.ticketDigest) ||
      !validText(record.unitName) ||
      !["systemd_call_issued", "applied_or_unknown"].includes(record.state) ||
      !hasCanonicalFingerprint(
        record.mutationFence,
        record.mutationFenceFingerprint,
      ) ||
      record.mutationFence.desiredEffect !== "process_stop"
    ) {
      throw new Error("incomplete effect WAL record");
    }
    return;
  }
  if (record.kind === "scope_state") {
    if (
      !validText(record.effectScopeKey) ||
      !validText(record.installedFingerprint) ||
      !validText(record.operationId) ||
      !["closed", "open"].includes(record.state)
    ) {
      throw new Error("incomplete scope-state WAL record");
    }
    return;
  }
  if (
    !validText(record.attemptId) ||
    !validText(record.executionGeneration) ||
    !validText(record.operationId) ||
    !validText(record.reason) ||
    !validText(record.unitName) ||
    record.mutationFenceFingerprint !==
      fingerprintMutationFence(record.mutationFence) ||
    record.mutationFence.attemptId !== record.attemptId ||
    record.mutationFence.executionGeneration !== record.executionGeneration ||
    record.mutationFence.nodeId !== record.nodeId ||
    record.mutationFence.nodeBootEpoch !== record.nodeBootEpoch ||
    !Number.isSafeInteger(record.nodeBootEpoch) ||
    record.nodeBootEpoch < 0 ||
    !validText(record.nodeBootId) ||
    !validText(record.nodeId) ||
    !isValidMutationFence(record.mutationFence) ||
    !["issued", "stopped_or_unknown"].includes(record.result)
  ) {
    throw new Error("incomplete break-glass WAL record");
  }
}

export type LauncherWalCordonReason =
  | "launcher_wal_corrupt"
  | "launcher_wal_full";

export class LauncherWalError extends Error {
  public constructor(public readonly code: LauncherWalCordonReason) {
    super(code);
    this.name = "LauncherWalError";
  }
}

function checksumFor(
  sequence: number,
  previousChecksum: string,
  record: LauncherWalRecord,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ previousChecksum, record, sequence }), "utf8")
    .digest("hex");
}

function parseEnvelope(line: string): WalEnvelope {
  const value = JSON.parse(line) as UntrustedWalEnvelope | null;
  const kind =
    typeof value?.record === "object" && value.record !== null
      ? (value.record as { readonly kind?: unknown }).kind
      : undefined;
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.previousChecksum !== "string" ||
    typeof value.checksum !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.checksum) ||
    typeof value.record !== "object" ||
    value.record === null ||
    typeof kind !== "string" ||
    ![
      "authority_installed",
      "break_glass_stop",
      "control_partition",
      "effect_state",
      "scope_state",
      "start_state",
    ].includes(kind)
  ) {
    throw new Error("invalid launcher WAL envelope");
  }
  validateWalRecord(value.record as LauncherWalRecord);
  return value as unknown as WalEnvelope;
}

export class LauncherWal {
  readonly #records: RecoveredLauncherWalRecord[] = [];
  #cordonReason: LauncherWalCordonReason | undefined;

  public constructor(private readonly storage: LauncherWalStorage) {
    this.recover();
  }

  public get cordonReason(): LauncherWalCordonReason | undefined {
    return this.#cordonReason;
  }

  public get records(): readonly RecoveredLauncherWalRecord[] {
    return this.#records;
  }

  public reserve(recordCount: number): void {
    this.assertHealthy();
    if (
      !Number.isSafeInteger(recordCount) ||
      recordCount < 1 ||
      this.#records.length + recordCount > this.storage.capacity
    ) {
      this.#cordonReason = "launcher_wal_full";
      throw new LauncherWalError(this.#cordonReason);
    }
  }

  public append(record: LauncherWalRecord): RecoveredLauncherWalRecord {
    this.assertHealthy();
    try {
      validateWalRecord(record);
    } catch {
      this.#cordonReason = "launcher_wal_corrupt";
      throw new LauncherWalError(this.#cordonReason);
    }
    if (this.#records.length >= this.storage.capacity) {
      this.#cordonReason = "launcher_wal_full";
      throw new LauncherWalError(this.#cordonReason);
    }
    const sequence = this.#records.length + 1;
    const previousChecksum = this.#records.at(-1)?.checksum ?? "0".repeat(64);
    const checksum = checksumFor(sequence, previousChecksum, record);
    const envelope: WalEnvelope = {
      checksum,
      previousChecksum,
      record,
      sequence,
    };
    try {
      this.storage.appendAndSync(JSON.stringify(envelope));
    } catch {
      this.#cordonReason = "launcher_wal_corrupt";
      throw new LauncherWalError(this.#cordonReason);
    }
    const recovered = Object.freeze({ checksum, record, sequence });
    this.#records.push(recovered);
    return recovered;
  }

  public assertHealthy(): void {
    if (this.#cordonReason !== undefined) {
      throw new LauncherWalError(this.#cordonReason);
    }
  }

  private recover(): void {
    let previousChecksum = "0".repeat(64);
    try {
      const lines = this.storage.readAll();
      if (lines.length > this.storage.capacity)
        throw new Error("WAL over capacity");
      for (const [index, line] of lines.entries()) {
        const envelope = parseEnvelope(line);
        const expectedSequence = index + 1;
        if (
          envelope.sequence !== expectedSequence ||
          envelope.previousChecksum !== previousChecksum ||
          envelope.checksum !==
            checksumFor(
              envelope.sequence,
              envelope.previousChecksum,
              envelope.record,
            )
        ) {
          throw new Error("WAL checksum or sequence mismatch");
        }
        this.#records.push(
          Object.freeze({
            checksum: envelope.checksum,
            record: envelope.record,
            sequence: envelope.sequence,
          }),
        );
        previousChecksum = envelope.checksum;
      }
    } catch {
      this.#records.length = 0;
      this.#cordonReason = "launcher_wal_corrupt";
    }
  }
}
