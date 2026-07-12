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

import type { LauncherWalStorage } from "./application/contracts/launcher-wal-storage.js";

export const PRODUCTION_LAUNCHER_WAL_DIRECTORY =
  "/var/lib/workload-funnel/node-launcher" as const;

export interface FilesystemLauncherWalConfig {
  readonly capacity: number;
  readonly directory: string;
  readonly maxRecordBytes?: number;
}

function validateConfig(config: FilesystemLauncherWalConfig): void {
  if (
    !isAbsolute(config.directory) ||
    !Number.isSafeInteger(config.capacity) ||
    config.capacity < 1 ||
    !Number.isSafeInteger(config.maxRecordBytes ?? 64 * 1024) ||
    (config.maxRecordBytes ?? 64 * 1024) < 256
  ) {
    throw new Error("invalid filesystem launcher WAL configuration");
  }
}

export class FilesystemLauncherWalStorage implements LauncherWalStorage {
  public readonly capacity: number;
  readonly #filePath: string;
  readonly #maxRecordBytes: number;

  public constructor(config: FilesystemLauncherWalConfig) {
    validateConfig(config);
    this.capacity = config.capacity;
    this.#maxRecordBytes = config.maxRecordBytes ?? 64 * 1024;
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
      throw new Error("launcher WAL directory is not a project-owned path");
    }
    this.#filePath = join(directory, "launcher.wal");
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
      throw new Error("launcher WAL record exceeds its closed bound");
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
    const maximumBytes = this.capacity * (this.#maxRecordBytes + 1);
    const metadata = lstatSync(this.#filePath);
    if (metadata.size > maximumBytes) {
      throw new Error("launcher WAL exceeds its bounded size");
    }
    const contents = readFileSync(this.#filePath, "utf8");
    if (contents.length === 0) return [];
    if (!contents.endsWith("\n")) {
      throw new Error("launcher WAL has a truncated final record");
    }
    const lines = contents.slice(0, -1).split("\n");
    if (
      lines.some(
        (line) =>
          line.length === 0 ||
          Buffer.byteLength(line, "utf8") > this.#maxRecordBytes,
      )
    ) {
      throw new Error("launcher WAL contains an invalid bounded record");
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
      throw new Error("launcher WAL must be a regular project-owned file");
    }
  }
}
