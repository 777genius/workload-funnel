import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";

interface OrderRecord {
  readonly digest: string;
  readonly ordinal: number;
  readonly previousDigest: string;
  readonly sequence: number;
  readonly source: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordDigest(record: Omit<OrderRecord, "digest">): string {
  return hash(JSON.stringify(record));
}

function trustedFile(path: string): void {
  const identity = lstatSync(path);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid?.() ||
    (identity.mode & 0o077) !== 0
  )
    throw new Error("hyperqueue_observation_order_identity_untrusted");
}

export class FilesystemHyperQueueObservationOrder {
  readonly durability = "restart_durable" as const;
  readonly #checkpointPath: string;
  readonly #descriptor: number;
  readonly #path: string;
  readonly #records: OrderRecord[] = [];
  readonly #sequences = new Map<string, number>();

  public constructor(path: string) {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("hyperqueue_observation_order_path_invalid");
    this.#path = path;
    this.#checkpointPath = `${path}.checkpoint`;
    mkdirSync(dirname(path), { mode: 0o700, recursive: true });
    const directory = lstatSync(dirname(path));
    if (
      realpathSync(dirname(path)) !== dirname(path) ||
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error("hyperqueue_observation_order_directory_untrusted");
    if (!existsSync(path)) {
      const descriptor = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      this.#syncDirectory();
    }
    trustedFile(path);
    this.#descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW,
    );
    this.#assertWalIdentity();
    const temporary = `${this.#checkpointPath}.tmp`;
    if (existsSync(temporary)) {
      trustedFile(temporary);
      rmSync(temporary);
      this.#syncDirectory();
    }
    this.#recover();
  }

  public async next(
    source: string,
  ): Promise<Readonly<{ sourceEpoch: number; sourceSequence: number }>> {
    await Promise.resolve();
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(source))
      throw new Error("hyperqueue_observation_order_source_invalid");
    const base = Object.freeze({
      ordinal: this.#records.length + 1,
      previousDigest: this.#records.at(-1)?.digest ?? "0".repeat(64),
      sequence: (this.#sequences.get(source) ?? 0) + 1,
      source,
    });
    const record = Object.freeze({ ...base, digest: recordDigest(base) });
    this.#assertWalIdentity();
    writeSync(
      this.#descriptor,
      `${JSON.stringify(record)}\n`,
      undefined,
      "utf8",
    );
    fsyncSync(this.#descriptor);
    this.#records.push(record);
    this.#sequences.set(source, record.sequence);
    this.#writeCheckpoint();
    return Object.freeze({ sourceEpoch: 1, sourceSequence: record.sequence });
  }

  #recover(): void {
    const text = readFileSync(this.#descriptor, "utf8");
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error("hyperqueue_observation_order_full");
    if (text.length > 0 && !text.endsWith("\n"))
      throw new Error("hyperqueue_observation_order_corrupt");
    let previous = "0".repeat(64);
    for (const [index, line] of text.split("\n").filter(Boolean).entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error("hyperqueue_observation_order_corrupt");
      }
      const record = value as Partial<OrderRecord>;
      const base = {
        ordinal: record.ordinal,
        previousDigest: record.previousDigest,
        sequence: record.sequence,
        source: record.source,
      };
      if (
        typeof record.digest !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.digest) ||
        record.ordinal !== index + 1 ||
        record.previousDigest !== previous ||
        typeof record.source !== "string" ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(record.source) ||
        !Number.isSafeInteger(record.sequence) ||
        record.sequence !== (this.#sequences.get(record.source) ?? 0) + 1 ||
        record.digest !== recordDigest(base as Omit<OrderRecord, "digest">)
      )
        throw new Error("hyperqueue_observation_order_corrupt");
      const valid = record as OrderRecord;
      this.#records.push(valid);
      this.#sequences.set(valid.source, valid.sequence);
      previous = valid.digest;
    }
    if (existsSync(this.#checkpointPath)) {
      trustedFile(this.#checkpointPath);
      let checkpoint: unknown;
      try {
        checkpoint = JSON.parse(readFileSync(this.#checkpointPath, "utf8"));
      } catch {
        throw new Error("hyperqueue_observation_order_corrupt");
      }
      const value = checkpoint as Readonly<{
        digest?: unknown;
        ordinal?: unknown;
      }>;
      if (
        !Number.isSafeInteger(value.ordinal) ||
        (value.ordinal as number) > this.#records.length ||
        (value.ordinal as number) < 0 ||
        (value.ordinal === 0
          ? value.digest !== "0".repeat(64)
          : value.digest !==
            this.#records[(value.ordinal as number) - 1]?.digest)
      )
        throw new Error("hyperqueue_observation_order_corrupt");
    }
    this.#writeCheckpoint();
  }

  #writeCheckpoint(): void {
    const temporary = `${this.#checkpointPath}.tmp`;
    if (existsSync(temporary))
      throw new Error("hyperqueue_observation_order_checkpoint_incomplete");
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(
        descriptor,
        `${JSON.stringify({
          digest: this.#records.at(-1)?.digest ?? "0".repeat(64),
          ordinal: this.#records.length,
        })}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.#checkpointPath);
    this.#syncDirectory();
  }

  #assertWalIdentity(): void {
    const pathIdentity = lstatSync(this.#path);
    const descriptorIdentity = fstatSync(this.#descriptor);
    if (
      pathIdentity.dev !== descriptorIdentity.dev ||
      pathIdentity.ino !== descriptorIdentity.ino ||
      !descriptorIdentity.isFile() ||
      descriptorIdentity.uid !== process.getuid?.() ||
      (descriptorIdentity.mode & 0o077) !== 0
    )
      throw new Error("hyperqueue_observation_order_identity_changed");
  }

  #syncDirectory(): void {
    const directory = openSync(dirname(this.#path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
}
