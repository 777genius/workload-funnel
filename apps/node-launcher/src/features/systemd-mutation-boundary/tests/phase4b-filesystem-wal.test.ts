import {
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FilesystemLauncherWalStorage } from "@workload-funnel/node-launcher/authority-registry";
import { parseLauncherRpcResponse } from "@workload-funnel/node-execution/process-lifecycle";

import {
  SyntheticSystemdManager,
  agentPeer,
  fixture,
  newKeys,
  request,
  signedTicket,
} from "./phase4b-launcher-fixture.js";

describe("Phase 4B filesystem launcher WAL", () => {
  it("reopens, bounds, and cordons a disposable filesystem ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "workload-funnel-launcher-wal-"));
    try {
      const directory = join(root, "durable");
      const storage = new FilesystemLauncherWalStorage({
        capacity: 100,
        directory,
      });
      const manager = new SyntheticSystemdManager();
      const keys = newKeys();
      const first = fixture(storage, manager, keys);
      expect(
        parseLauncherRpcResponse(
          first.boundary.handle(
            request(signedTicket(first), "filesystem-start"),
            agentPeer,
          ),
        ),
      ).toMatchObject({ ok: true, result: { state: "started" } });
      const reopened = fixture(
        new FilesystemLauncherWalStorage({ capacity: 100, directory }),
        manager,
        keys,
      );
      expect(reopened.registry.cordoned).toBe(false);
      expect(
        parseLauncherRpcResponse(
          reopened.boundary.handle(
            request(signedTicket(reopened), "filesystem-replay"),
            agentPeer,
          ),
        ),
      ).toMatchObject({ ok: true, result: { state: "started" } });
      expect(manager.starts).toHaveLength(1);

      const ledger = join(directory, "launcher.wal");
      truncateSync(ledger, readFileSync(ledger).byteLength - 1);
      const truncated = fixture(
        new FilesystemLauncherWalStorage({ capacity: 100, directory }),
        new SyntheticSystemdManager(),
        keys,
      );
      expect(truncated.registry.cordoned).toBe(true);

      const corruptDirectory = join(root, "corrupt");
      fixture(
        new FilesystemLauncherWalStorage({
          capacity: 100,
          directory: corruptDirectory,
        }),
        new SyntheticSystemdManager(),
        keys,
      );
      const corruptLedger = join(corruptDirectory, "launcher.wal");
      const bytes = readFileSync(corruptLedger);
      const corruptIndex = Math.floor(bytes.byteLength / 2);
      bytes[corruptIndex] = (bytes[corruptIndex] ?? 0) ^ 1;
      writeFileSync(corruptLedger, bytes);
      expect(
        fixture(
          new FilesystemLauncherWalStorage({
            capacity: 100,
            directory: corruptDirectory,
          }),
          new SyntheticSystemdManager(),
          keys,
        ).registry.cordoned,
      ).toBe(true);

      const full = fixture(
        new FilesystemLauncherWalStorage({
          capacity: 1,
          directory: join(root, "full"),
        }),
      );
      expect(
        parseLauncherRpcResponse(
          full.boundary.handle(
            request(signedTicket(full), "filesystem-full"),
            agentPeer,
          ),
        ),
      ).toMatchObject({ error: { code: "launcher_cordoned" }, ok: false });
      expect(full.manager.starts).toHaveLength(0);

      const bounded = new FilesystemLauncherWalStorage({
        capacity: 10,
        directory: join(root, "bounded"),
        maxRecordBytes: 256,
      });
      expect(() => {
        bounded.appendAndSync("x".repeat(257));
      }).toThrow("closed bound");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
