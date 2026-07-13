import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { GatewayWalStorage } from "./application/contracts/gateway-wal-storage.js";

export const PRODUCTION_SCHEDULER_GATEWAY_WAL =
  "/var/lib/workload-funnel/scheduler-gateway/authority.wal" as const;

export interface FilesystemGatewayWalConfig {
  readonly capacity: number;
  readonly expectedUid?: number;
  readonly path: string;
}

export class FilesystemGatewayWalStorage implements GatewayWalStorage {
  public readonly capacity: number;
  readonly #directory: string;
  readonly #checkpointPath: string;
  readonly #checkpointTemporaryPath: string;
  readonly #expectedUid: number;
  readonly #path: string;

  public constructor(config: FilesystemGatewayWalConfig) {
    if (!Number.isSafeInteger(config.capacity) || config.capacity < 1)
      throw new Error("gateway_wal_capacity_invalid");
    if (!isAbsolute(config.path)) throw new Error("gateway_wal_path_invalid");
    this.capacity = config.capacity;
    this.#expectedUid = config.expectedUid ?? process.getuid?.() ?? 0;
    this.#path = resolve(config.path);
    this.#checkpointPath = `${this.#path}.checkpoint`;
    this.#checkpointTemporaryPath = `${this.#checkpointPath}.tmp`;
    this.#directory = dirname(this.#path);
    mkdirSync(this.#directory, { mode: 0o700, recursive: true });
    const directory = lstatSync(this.#directory);
    if (
      !directory.isDirectory() ||
      directory.uid !== this.#expectedUid ||
      (directory.mode & 0o077) !== 0
    )
      throw new Error("gateway_wal_directory_untrusted");
    if (existsSync(this.#path)) this.assertTrustedFile(lstatSync(this.#path));
    if (existsSync(this.#checkpointPath))
      this.assertTrustedFile(lstatSync(this.#checkpointPath));
  }

  public appendAndSync(line: string, checkpoint: string): void {
    if (
      line.includes("\n") ||
      Buffer.byteLength(line) > 2 * 1024 * 1024 ||
      checkpoint.includes("\n") ||
      Buffer.byteLength(checkpoint) > 512
    )
      throw new Error("gateway_wal_record_invalid");
    const descriptor = openSync(
      this.#path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    try {
      this.assertTrustedFile(fstatSync(descriptor));
      this.writeAll(descriptor, Buffer.from(`${line}\n`, "utf8"));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.fsyncDirectory();
    if (existsSync(this.#checkpointTemporaryPath))
      throw new Error("gateway_wal_checkpoint_incomplete");
    const checkpointDescriptor = openSync(
      this.#checkpointTemporaryPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_WRONLY,
      0o600,
    );
    try {
      this.assertTrustedFile(fstatSync(checkpointDescriptor));
      this.writeAll(
        checkpointDescriptor,
        Buffer.from(`${checkpoint}\n`, "utf8"),
      );
      fsyncSync(checkpointDescriptor);
    } finally {
      closeSync(checkpointDescriptor);
    }
    renameSync(this.#checkpointTemporaryPath, this.#checkpointPath);
    this.fsyncDirectory();
  }

  public readAll(): readonly string[] {
    if (!existsSync(this.#path)) return [];
    const descriptor = openSync(
      this.#path,
      constants.O_NOFOLLOW | constants.O_RDONLY,
    );
    let content: string;
    try {
      const identity = fstatSync(descriptor);
      this.assertTrustedFile(identity);
      if (identity.size > this.capacity * 2 * 1024 * 1024)
        throw new Error("gateway_wal_size_invalid");
      content = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
    if (content.length === 0) return [];
    if (!content.endsWith("\n")) throw new Error("gateway_wal_truncated");
    return content.slice(0, -1).split("\n");
  }

  public readCheckpoint(): string | null {
    if (existsSync(this.#checkpointTemporaryPath))
      throw new Error("gateway_wal_checkpoint_incomplete");
    if (!existsSync(this.#checkpointPath)) return null;
    const descriptor = openSync(
      this.#checkpointPath,
      constants.O_NOFOLLOW | constants.O_RDONLY,
    );
    try {
      const identity = fstatSync(descriptor);
      this.assertTrustedFile(identity);
      if (identity.size > 513)
        throw new Error("gateway_wal_checkpoint_invalid");
      const content = readFileSync(descriptor, "utf8");
      if (!content.endsWith("\n") || content.slice(0, -1).includes("\n"))
        throw new Error("gateway_wal_checkpoint_invalid");
      return content.slice(0, -1);
    } finally {
      closeSync(descriptor);
    }
  }

  private fsyncDirectory(): void {
    const directory = openSync(
      this.#directory,
      constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY,
    );
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }

  private writeAll(descriptor: number, bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
      );
      if (written < 1) throw new Error("gateway_wal_write_stalled");
      offset += written;
    }
  }

  private assertTrustedFile(identity: Stats): void {
    if (
      !identity.isFile() ||
      identity.uid !== this.#expectedUid ||
      (identity.mode & 0o077) !== 0
    )
      throw new Error("gateway_wal_file_untrusted");
  }
}
