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

import type { ObservationSpoolStorage } from "./application/contracts/observation-spool-storage.js";

export const PRODUCTION_OBSERVATION_SPOOL_DIRECTORY =
  "/var/lib/workload-funnel/node-agent" as const;

export interface FilesystemObservationSpoolConfig {
  readonly capacity: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

export class FilesystemObservationSpoolStorage implements ObservationSpoolStorage {
  public readonly capacity: number;
  readonly #filePath: string;
  readonly #maxRecordBytes: number;

  public constructor(config: FilesystemObservationSpoolConfig) {
    const maxRecordBytes = config.maxRecordBytes ?? 64 * 1024;
    if (
      !isAbsolute(config.directory) ||
      !Number.isSafeInteger(config.capacity) ||
      config.capacity < 1 ||
      !Number.isSafeInteger(maxRecordBytes) ||
      maxRecordBytes < 256
    ) {
      throw new Error("invalid filesystem observation spool configuration");
    }
    this.capacity = config.capacity;
    this.#maxRecordBytes = maxRecordBytes;
    const directory = resolve(config.directory);
    mkdirSync(directory, { mode: 0o700, recursive: true });
    const metadata = lstatSync(directory);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      realpathSync(directory) !== directory ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("observation spool directory is not project-owned");
    }
    this.#filePath = join(directory, "observations.spool");
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
      const directoryFd = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
    this.assertRegularLedger();
  }

  public appendAndSync(serializedRecord: string): void {
    const payload = Buffer.from(`${serializedRecord}\n`, "utf8");
    if (
      serializedRecord.includes("\n") ||
      serializedRecord.includes("\r") ||
      payload.byteLength - 1 > this.#maxRecordBytes
    ) {
      throw new Error("observation spool record exceeds its closed bound");
    }
    this.assertRegularLedger();
    const fd = openSync(
      this.#filePath,
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_WRONLY,
    );
    try {
      let offset = 0;
      while (offset < payload.byteLength) {
        offset += writeSync(fd, payload, offset, payload.byteLength - offset);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  public readAll(): readonly string[] {
    this.assertRegularLedger();
    const metadata = lstatSync(this.#filePath);
    if (metadata.size > this.capacity * (this.#maxRecordBytes + 1)) {
      throw new Error("observation spool exceeds its bounded size");
    }
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return [];
    if (!contents.endsWith("\n")) {
      throw new Error("observation spool has a truncated final record");
    }
    const lines = contents.slice(0, -1).split("\n");
    if (
      lines.some(
        (line) =>
          line.length === 0 ||
          Buffer.byteLength(line, "utf8") > this.#maxRecordBytes,
      )
    ) {
      throw new Error("observation spool contains an invalid bounded record");
    }
    return lines;
  }

  private assertRegularLedger(): void {
    const metadata = lstatSync(this.#filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      (process.getuid !== undefined && metadata.uid !== process.getuid()) ||
      (metadata.mode & 0o177) !== 0
    ) {
      throw new Error("observation spool must be a regular project-owned file");
    }
  }
}
