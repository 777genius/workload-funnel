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

import type { SealerWalStorage } from "./application/contracts/sealer-wal-storage.js";

export const PRODUCTION_RESULT_SEALER_WAL_DIRECTORY =
  "/var/lib/workload-funnel/result-sealer" as const;

export interface FilesystemSealerWalConfig {
  readonly capacity: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

export class FilesystemSealerWalStorage implements SealerWalStorage {
  public readonly capacity: number;
  public readonly recoveryState: "new" | "existing";
  readonly #filePath: string;
  readonly #commitPath: string;
  readonly #directory: string;
  readonly #anchorPath: string;
  readonly #maxRecordBytes: number;

  public constructor(config: FilesystemSealerWalConfig) {
    const maxRecordBytes = config.maxRecordBytes ?? 256 * 1024;
    if (
      !isAbsolute(config.directory) ||
      !Number.isSafeInteger(config.capacity) ||
      config.capacity < 1 ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 1024
    )
      throw new Error("invalid_result_sealer_wal_configuration");
    this.capacity = config.capacity;
    this.#maxRecordBytes = maxRecordBytes;
    const directory = resolve(config.directory);
    this.#directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryMetadata = lstatSync(directory);
    if (
      !directoryMetadata.isDirectory() ||
      directoryMetadata.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      (process.getuid !== undefined &&
        directoryMetadata.uid !== process.getuid()) ||
      (directoryMetadata.mode & 0o077) !== 0
    )
      throw new Error("unsafe_result_sealer_wal_directory");
    this.#filePath = join(directory, "result-sealer.wal");
    this.#commitPath = join(directory, "result-sealer.commit");
    this.#anchorPath = join(directory, "result-sealer.initialized");
    const anchorExisted = existsSync(this.#anchorPath);
    const existed = existsSync(this.#filePath);
    this.recoveryState =
      anchorExisted || existed || existsSync(this.#commitPath)
        ? "existing"
        : "new";
    if (!anchorExisted) {
      const anchor = openSync(
        this.#anchorPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW |
          constants.O_WRONLY,
        0o600,
      );
      try {
        writeSync(anchor, "result-sealer-wal-v1\n");
        fsyncSync(anchor);
      } finally {
        closeSync(anchor);
      }
    }
    const descriptor = openSync(
      this.#filePath,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    if (!existed || !anchorExisted) {
      const directoryDescriptor = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
    }
    const anchorMetadata = lstatSync(this.#anchorPath);
    if (
      !anchorMetadata.isFile() ||
      anchorMetadata.isSymbolicLink() ||
      anchorMetadata.nlink !== 1 ||
      readFileSync(this.#anchorPath, "utf8") !== "result-sealer-wal-v1\n"
    )
      throw new Error("unsafe_result_sealer_wal_anchor");
    this.assertLedger();
  }

  public appendAndSync(serializedRecord: string, commit: string): void {
    const bytes = Buffer.from(`${serializedRecord}\n`, "utf8");
    if (
      serializedRecord.includes("\n") ||
      serializedRecord.includes("\r") ||
      bytes.byteLength - 1 > this.#maxRecordBytes
    )
      throw new Error("result_sealer_wal_record_too_large");
    this.assertLedger();
    const descriptor = openSync(
      this.#filePath,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      let offset = 0;
      while (offset < bytes.byteLength)
        offset += writeSync(
          descriptor,
          bytes,
          offset,
          bytes.byteLength - offset,
        );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const commitDescriptor = openSync(
      this.#commitPath,
      constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_TRUNC |
        constants.O_WRONLY,
      0o600,
    );
    try {
      const commitBytes = Buffer.from(commit, "utf8");
      let offset = 0;
      while (offset < commitBytes.byteLength)
        offset += writeSync(
          commitDescriptor,
          commitBytes,
          offset,
          commitBytes.byteLength - offset,
        );
      fsyncSync(commitDescriptor);
    } finally {
      closeSync(commitDescriptor);
    }
    const directoryDescriptor = openSync(this.#directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }

  public readCommit(): string | undefined {
    if (!existsSync(this.#commitPath)) return undefined;
    const metadata = lstatSync(this.#commitPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > 1024 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o177) !== 0
    )
      throw new Error("unsafe_result_sealer_wal_commit");
    return readFileSync(this.#commitPath, "utf8");
  }

  public readAll(): readonly string[] {
    this.assertLedger();
    const metadata = lstatSync(this.#filePath);
    if (metadata.size > this.capacity * (this.#maxRecordBytes + 1))
      throw new Error("result_sealer_wal_overflow");
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return [];
    if (!contents.endsWith("\n"))
      throw new Error("result_sealer_wal_truncated");
    const lines = contents.slice(0, -1).split("\n");
    if (
      lines.some(
        (line) =>
          line.length === 0 || Buffer.byteLength(line) > this.#maxRecordBytes,
      )
    ) {
      throw new Error("result_sealer_wal_invalid_record");
    }
    return lines;
  }

  private assertLedger(): void {
    const metadata = lstatSync(this.#filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o177) !== 0
    )
      throw new Error("unsafe_result_sealer_wal");
  }
}
