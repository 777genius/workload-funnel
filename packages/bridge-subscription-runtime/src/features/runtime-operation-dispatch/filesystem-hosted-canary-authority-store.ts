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

import {
  fingerprintMutationFence,
  type MutationFence,
  sha256Hex,
} from "@workload-funnel/kernel";

import type { HostedCanaryAuthorityStore } from "./application/contracts/hosted-canary-runtime.js";
import { assertHostedCanaryFence } from "./application/hosted-canary-runtime-policy.js";

interface AuthorityRecord {
  readonly digest: string;
  readonly fence: MutationFence;
  readonly fingerprint: string;
  readonly previousDigest: string;
  readonly schemaVersion: "hosted-canary-authority.v1";
  readonly sequence: number;
}

export interface FilesystemHostedCanaryAuthorityStoreConfig {
  readonly capacity?: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

const genesisDigest = "0".repeat(64);

function identityEqual(
  left: MutationFence,
  right: MutationFence,
  component:
    | "allocation"
    | "attempt"
    | "cluster"
    | "desired"
    | "gate"
    | "namespace"
    | "node",
): boolean {
  switch (component) {
    case "cluster":
      return left.clusterIncarnation === right.clusterIncarnation;
    case "namespace":
      return left.namespaceId === right.namespaceId;
    case "allocation":
      return (
        left.allocationId === right.allocationId &&
        left.attemptId === right.attemptId &&
        left.executionGeneration === right.executionGeneration
      );
    case "attempt":
      return (
        left.startFence === right.startFence &&
        left.executionGeneration === right.executionGeneration
      );
    case "gate":
      return left.requiredGate === right.requiredGate;
    case "desired":
      return (
        left.desiredEffect === right.desiredEffect &&
        left.supersessionKey === right.supersessionKey
      );
    case "node":
      return left.nodeId === right.nodeId;
  }
}

function compare(
  current: MutationFence,
  proposed: MutationFence,
  currentVersion: number | undefined,
  proposedVersion: number | undefined,
  component: Parameters<typeof identityEqual>[2],
): boolean {
  if (currentVersion === undefined || proposedVersion === undefined) {
    if (currentVersion !== proposedVersion)
      throw new Error(`hosted_canary_authority_missing_${component}`);
    return false;
  }
  if (proposedVersion < currentVersion)
    throw new Error(`hosted_canary_authority_lower_${component}`);
  if (
    proposedVersion === currentVersion &&
    !identityEqual(current, proposed, component)
  )
    throw new Error(`hosted_canary_authority_equal_mismatch_${component}`);
  return proposedVersion > currentVersion;
}

function compareAuthority(
  current: MutationFence,
  proposed: MutationFence,
): boolean {
  const advanced = [
    compare(
      current,
      proposed,
      current.clusterIncarnationVersion,
      proposed.clusterIncarnationVersion,
      "cluster",
    ),
  ];
  if (current.namespaceId === proposed.namespaceId) {
    advanced.push(
      compare(
        current,
        proposed,
        current.namespaceWriterEpoch,
        proposed.namespaceWriterEpoch,
        "namespace",
      ),
    );
    advanced.push(
      compare(
        current,
        proposed,
        current.operationGateRevision,
        proposed.operationGateRevision,
        "gate",
      ),
    );
  }
  if (current.allocationId === proposed.allocationId)
    advanced.push(
      compare(
        current,
        proposed,
        current.ownerFence,
        proposed.ownerFence,
        "allocation",
      ),
    );
  if (
    current.namespaceId === proposed.namespaceId &&
    current.attemptId === proposed.attemptId &&
    current.executionGeneration === proposed.executionGeneration &&
    current.startFence !== undefined &&
    proposed.startFence !== undefined
  )
    advanced.push(
      compare(
        current,
        proposed,
        current.issuedStartRevocationRevision,
        proposed.issuedStartRevocationRevision,
        "attempt",
      ),
    );
  if (
    current.nodeId === proposed.nodeId ||
    current.effectScopeKey === proposed.effectScopeKey
  )
    advanced.push(
      compare(
        current,
        proposed,
        current.nodeBootEpoch,
        proposed.nodeBootEpoch,
        "node",
      ),
    );
  if (current.effectScopeKey === proposed.effectScopeKey) {
    if (
      current.namespaceId !== proposed.namespaceId ||
      current.attemptId !== proposed.attemptId ||
      current.executionGeneration !== proposed.executionGeneration ||
      current.allocationId !== proposed.allocationId
    )
      throw new Error("hosted_canary_authority_scope_identity_mismatch");
    advanced.push(
      compare(
        current,
        proposed,
        current.expectedDesiredVersion,
        proposed.expectedDesiredVersion,
        "desired",
      ),
    );
  }
  return advanced.some(Boolean);
}

function digest(
  sequence: number,
  previousDigest: string,
  fence: MutationFence,
  fingerprint: string,
): string {
  return sha256Hex(
    JSON.stringify([
      "hosted-canary-authority.v1",
      sequence,
      previousDigest,
      fence,
      fingerprint,
    ]),
  );
}

function parseRecord(line: string): AuthorityRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    throw new Error("hosted_canary_authority_corrupt");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("hosted_canary_authority_corrupt");
  const wire = parsed as Readonly<Record<string, unknown>>;
  if (
    wire["schemaVersion"] !== "hosted-canary-authority.v1" ||
    !Number.isSafeInteger(wire["sequence"]) ||
    typeof wire["digest"] !== "string" ||
    typeof wire["fingerprint"] !== "string" ||
    typeof wire["previousDigest"] !== "string" ||
    typeof wire["fence"] !== "object" ||
    wire["fence"] === null ||
    Array.isArray(wire["fence"])
  )
    throw new Error("hosted_canary_authority_corrupt");
  return parsed as AuthorityRecord;
}

export class FilesystemHostedCanaryAuthorityStore implements HostedCanaryAuthorityStore {
  readonly #capacity: number;
  readonly #directory: string;
  readonly #filePath: string;
  readonly #maxRecordBytes: number;
  readonly #records: AuthorityRecord[] = [];
  #lastDigest = genesisDigest;

  public constructor(config: FilesystemHostedCanaryAuthorityStoreConfig) {
    this.#capacity = config.capacity ?? 128;
    this.#maxRecordBytes = config.maxRecordBytes ?? 128 * 1024;
    if (
      !isAbsolute(config.directory) ||
      !Number.isSafeInteger(this.#capacity) ||
      this.#capacity < 1 ||
      !Number.isSafeInteger(this.#maxRecordBytes) ||
      this.#maxRecordBytes < 1_024
    )
      throw new Error("hosted_canary_authority_config_invalid");
    this.#directory = resolve(config.directory);
    mkdirSync(this.#directory, { mode: 0o700, recursive: true });
    this.assertDirectory();
    this.#filePath = join(this.#directory, "hosted-canary-authority.wal");
    this.openLedger();
    this.replay();
  }

  public assertCurrent(fence: MutationFence, fingerprint: string): void {
    if (
      fence.desiredEffect !== "process_start" &&
      fence.desiredEffect !== "process_stop"
    )
      throw new Error("hosted_canary_authority_effect_invalid");
    assertHostedCanaryFence(fence, fingerprint, fence.desiredEffect);
    const installed = this.#records
      .filter((record) => record.fence.effectScopeKey === fence.effectScopeKey)
      .at(-1);
    if (installed?.fingerprint !== fingerprint)
      throw new Error("hosted_canary_authority_not_current");
    for (const record of this.#records) compareAuthority(record.fence, fence);
  }

  public install(
    fence: MutationFence,
    fingerprint: string,
  ): "idempotent" | "installed" {
    if (
      fence.desiredEffect !== "process_start" &&
      fence.desiredEffect !== "process_stop"
    )
      throw new Error("hosted_canary_authority_effect_invalid");
    assertHostedCanaryFence(fence, fingerprint, fence.desiredEffect);
    const current = this.#records
      .filter((record) => record.fence.effectScopeKey === fence.effectScopeKey)
      .at(-1);
    let currentAdvanced = false;
    for (const record of this.#records) {
      const advanced = compareAuthority(record.fence, fence);
      if (record === current) currentAdvanced = advanced;
    }
    if (current?.fingerprint === fingerprint) return "idempotent";
    if (current !== undefined && !currentAdvanced)
      throw new Error("hosted_canary_authority_equal_tuple_mismatch");
    this.append(fence, fingerprint);
    return "installed";
  }

  private append(fence: MutationFence, fingerprint: string): void {
    if (this.#records.length >= this.#capacity)
      throw new Error("hosted_canary_authority_capacity_exceeded");
    const sequence = this.#records.length + 1;
    const record: AuthorityRecord = {
      digest: digest(sequence, this.#lastDigest, fence, fingerprint),
      fence,
      fingerprint,
      previousDigest: this.#lastDigest,
      schemaVersion: "hosted-canary-authority.v1",
      sequence,
    };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.byteLength - 1 > this.#maxRecordBytes)
      throw new Error("hosted_canary_authority_record_too_large");
    const fd = openSync(
      this.#filePath,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      if (writeSync(fd, bytes) !== bytes.byteLength)
        throw new Error("hosted_canary_authority_short_append");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#records.push(record);
    this.#lastDigest = record.digest;
  }

  private replay(): void {
    this.assertLedger();
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return;
    if (!contents.endsWith("\n"))
      throw new Error("hosted_canary_authority_truncated");
    for (const line of contents.slice(0, -1).split("\n")) {
      if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes)
        throw new Error("hosted_canary_authority_record_too_large");
      const record = parseRecord(line);
      if (
        record.fence.desiredEffect !== "process_start" &&
        record.fence.desiredEffect !== "process_stop"
      )
        throw new Error("hosted_canary_authority_corrupt");
      try {
        assertHostedCanaryFence(
          record.fence,
          record.fingerprint,
          record.fence.desiredEffect,
        );
      } catch {
        throw new Error("hosted_canary_authority_corrupt");
      }
      if (
        record.sequence !== this.#records.length + 1 ||
        record.previousDigest !== this.#lastDigest ||
        record.fingerprint !== fingerprintMutationFence(record.fence) ||
        record.digest !==
          digest(
            record.sequence,
            record.previousDigest,
            record.fence,
            record.fingerprint,
          )
      )
        throw new Error("hosted_canary_authority_corrupt");
      this.installRecovered(record);
    }
  }

  private installRecovered(record: AuthorityRecord): void {
    const current = this.#records
      .filter(
        (prior) => prior.fence.effectScopeKey === record.fence.effectScopeKey,
      )
      .at(-1);
    let currentAdvanced = false;
    for (const prior of this.#records) {
      const advanced = compareAuthority(prior.fence, record.fence);
      if (prior === current) currentAdvanced = advanced;
    }
    if (current !== undefined && !currentAdvanced)
      throw new Error("hosted_canary_authority_equal_tuple_mismatch");
    this.#records.push(record);
    this.#lastDigest = record.digest;
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
    )
      throw new Error("hosted_canary_authority_directory_unsafe");
  }

  private assertLedger(): void {
    const metadata = lstatSync(this.#filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o177) !== 0 ||
      metadata.size > this.#capacity * (this.#maxRecordBytes + 1)
    )
      throw new Error("hosted_canary_authority_ledger_unsafe");
  }
}
