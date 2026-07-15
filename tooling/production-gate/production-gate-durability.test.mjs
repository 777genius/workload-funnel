import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FilesystemHyperQueueObservationOrder } from "@workload-funnel/scheduler-hyperqueue/dispatch-observation";
import { cleanupOwnedDirectoryRecord } from "./owned-directory.mjs";
import { OwnedResourceLedger } from "./resource-ledger.mjs";
import { writeSecretFile } from "./secret-files.mjs";

const runId = "wf-production-gate-0123456789abcdef0123456789abcdef";
const directories = [];

async function temporaryDirectory(name) {
  const path = join(tmpdir(), `${name}-${process.pid}-${Date.now()}`);
  await mkdir(path, { mode: 0o700 });
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("production gate crash durability", () => {
  it("recovers a prepared effect and retains uncertain cleanup across reopen", async () => {
    const directory = await temporaryDirectory("wf-gate-ledger-crash");
    const ledgerPath = join(directory, "cleanup-ledger.json");
    const effectPath = join(directory, "effect");
    const bytes = Buffer.from("prepared-effect", "utf8");
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
    const ledger = await OwnedResourceLedger.open({ path: ledgerPath, runId });
    await ledger.prepare("fixture", `${runId}-effect`, {
      path: effectPath,
      sha256: expectedSha256,
    });
    await writeFile(effectPath, bytes, { flag: "wx", mode: 0o600 });

    const uncertain = await OwnedResourceLedger.open({
      path: ledgerPath,
      recoveryCleaners: {
        fixture: () => {
          throw new Error("synthetic_cleanup_uncertain");
        },
      },
      runId,
    });
    await expect(uncertain.recover()).resolves.toMatchObject({
      certain: false,
      pending: [
        expect.objectContaining({
          errorCode: "synthetic_cleanup_uncertain",
          state: "uncertain",
        }),
      ],
    });

    const recovered = await OwnedResourceLedger.open({
      path: ledgerPath,
      recoveryCleaners: {
        fixture: async (record) => {
          expect(record.expected).toEqual({
            path: effectPath,
            sha256: expectedSha256,
          });
          await rm(effectPath);
        },
      },
      runId,
    });
    await expect(recovered.recover()).resolves.toMatchObject({
      certain: true,
      pending: [],
    });
    await expect(readFile(effectPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed when the fsynced cleanup ledger is corrupted", async () => {
    const directory = await temporaryDirectory("wf-gate-ledger-corrupt");
    const ledgerPath = join(directory, "cleanup-ledger.json");
    const ledger = await OwnedResourceLedger.open({ path: ledgerPath, runId });
    await ledger.prepare("fixture", `${runId}-effect`);
    const envelope = JSON.parse(await readFile(ledgerPath, "utf8"));
    envelope.payload.records[0].name = `${runId}-different`;
    await writeFile(ledgerPath, `${JSON.stringify(envelope)}\n`, {
      mode: 0o600,
    });
    await expect(
      OwnedResourceLedger.open({ path: ledgerPath, runId }),
    ).rejects.toThrow("cleanup_ledger_corrupt");
  });

  it("promotes a fully written crash-staged ledger when rename was interrupted", async () => {
    const directory = await temporaryDirectory("wf-gate-ledger-rename-crash");
    const ledgerPath = join(directory, "cleanup-ledger.json");
    const ledger = await OwnedResourceLedger.open({ path: ledgerPath, runId });
    await ledger.prepare("fixture", `${runId}-effect`, { marker: "prepared" });
    await copyFile(ledgerPath, `${ledgerPath}.next`);
    await rm(ledgerPath);
    const recovered = await OwnedResourceLedger.open({
      path: ledgerPath,
      runId,
    });
    expect(recovered.snapshot()).toEqual([
      expect.objectContaining({
        expected: { marker: "prepared" },
        state: "prepared",
      }),
    ]);
  });

  it("serializes concurrent and sequential ledger mutations without loss across reopen", async () => {
    const directory = await temporaryDirectory("wf-gate-ledger-concurrency");
    const ledgerPath = join(directory, "cleanup-ledger.json");
    const ledger = await OwnedResourceLedger.open({ path: ledgerPath, runId });
    const concurrentNames = ["delete", "upload", "verify"];
    await Promise.all(
      concurrentNames.map((kind) =>
        writeSecretFile({
          contents: `${kind}-access\n${kind}-secret\n`,
          ledger,
          path: join(directory, `${kind}-identity`),
          runId,
          sandboxRoot: directory,
        }),
      ),
    );

    const firstReopen = await OwnedResourceLedger.open({
      path: ledgerPath,
      runId,
    });
    const concurrentSnapshot = firstReopen.snapshot();
    expect(concurrentSnapshot.map((record) => record.name)).toEqual(
      concurrentNames.map((kind) => `${runId}-${kind}-identity`),
    );
    expect(
      concurrentSnapshot.every((record) => record.state === "active"),
    ).toBe(true);
    expect(
      new Set(concurrentSnapshot.map((record) => record.recordId)).size,
    ).toBe(3);

    await writeSecretFile({
      contents: "sequential-access\nsequential-secret\n",
      ledger: firstReopen,
      path: join(directory, "sequential-identity"),
      runId,
      sandboxRoot: directory,
    });
    const duplicateName = `${runId}-duplicate-identity`;
    const duplicate = await Promise.allSettled([
      firstReopen.prepare("secret-file", duplicateName, { attempt: 1 }),
      firstReopen.prepare("secret-file", duplicateName, { attempt: 2 }),
    ]);
    expect(duplicate[0].status).toBe("fulfilled");
    expect(duplicate[1]).toMatchObject({
      reason: expect.objectContaining({ message: "duplicate_owned_resource" }),
      status: "rejected",
    });
    const duplicateRecordId = duplicate[0].value;
    await firstReopen.finalize(
      duplicateRecordId,
      { attempt: 1 },
      () => undefined,
    );
    const afterRejectedMutation = await firstReopen.prepare(
      "fixture",
      `${runId}-after-rejection`,
    );
    await firstReopen.finalize(
      afterRejectedMutation,
      { durable: true },
      () => undefined,
    );

    const finalReopen = await OwnedResourceLedger.open({
      path: ledgerPath,
      runId,
    });
    const finalSnapshot = finalReopen.snapshot();
    expect(finalSnapshot).toHaveLength(6);
    expect(new Set(finalSnapshot.map((record) => record.recordId)).size).toBe(
      6,
    );
    expect(new Set(finalSnapshot.map((record) => record.name)).size).toBe(6);
    expect(finalSnapshot.map((record) => record.name)).toEqual([
      ...concurrentNames.map((kind) => `${runId}-${kind}-identity`),
      `${runId}-sequential-identity`,
      duplicateName,
      `${runId}-after-rejection`,
    ]);
    expect(finalSnapshot.every((record) => record.state === "active")).toBe(
      true,
    );
  });

  it("recovers a prepared durable Postgres directory and refuses an inode swap", async () => {
    const directory = await temporaryDirectory("wf-postgres-data-recovery");
    const dataPath = join(directory, "postgres-data");
    const ledgerPath = join(directory, "cleanup-ledger.json");
    const expected = {
      gid: process.getuid?.() === 0 ? 70 : (process.getgid?.() ?? 0),
      mode: 0o700,
      path: dataPath,
      uid: process.getuid?.() === 0 ? 70 : (process.getuid?.() ?? 0),
    };
    const ledger = await OwnedResourceLedger.open({ path: ledgerPath, runId });
    await ledger.prepare("owned-directory", `${runId}-postgres-data`, expected);
    await mkdir(dataPath, { mode: 0o700 });
    const recovered = await OwnedResourceLedger.open({
      path: ledgerPath,
      recoveryCleaners: { "owned-directory": cleanupOwnedDirectoryRecord },
      runId,
    });
    await expect(recovered.recover()).resolves.toMatchObject({ certain: true });
    await expect(lstat(dataPath)).rejects.toMatchObject({ code: "ENOENT" });

    await mkdir(dataPath, { mode: 0o700 });
    const original = await lstat(dataPath);
    await rename(dataPath, `${dataPath}.replaced`);
    await mkdir(dataPath, { mode: 0o700 });
    await expect(
      cleanupOwnedDirectoryRecord({
        expected,
        observed: { device: original.dev, inode: original.ino },
      }),
    ).rejects.toThrow("owned_directory_cleanup_identity_changed");
    await expect(lstat(dataPath)).resolves.toMatchObject({});
    await expect(lstat(`${dataPath}.replaced`)).resolves.toMatchObject({});
  });

  it("keeps HyperQueue ordering monotonic across process-style reopen", async () => {
    const directory = await temporaryDirectory("wf-hq-order-restart");
    const path = join(directory, "observation.wal");
    const first = new FilesystemHyperQueueObservationOrder(path);
    await expect(first.next("dispatch-observation")).resolves.toEqual({
      sourceEpoch: 1,
      sourceSequence: 1,
    });
    await expect(first.next("worker-inventory")).resolves.toEqual({
      sourceEpoch: 1,
      sourceSequence: 1,
    });
    const reopened = new FilesystemHyperQueueObservationOrder(path);
    await expect(reopened.next("dispatch-observation")).resolves.toEqual({
      sourceEpoch: 1,
      sourceSequence: 2,
    });
    await expect(reopened.next("worker-inventory")).resolves.toEqual({
      sourceEpoch: 1,
      sourceSequence: 2,
    });
  });

  it("refuses WAL corruption and an adversarial path replacement", async () => {
    const corruptDirectory = await temporaryDirectory("wf-hq-order-corrupt");
    const corruptPath = join(corruptDirectory, "observation.wal");
    const first = new FilesystemHyperQueueObservationOrder(corruptPath);
    await first.next("dispatch-observation");
    await appendFile(corruptPath, "{corrupt}\n", "utf8");
    expect(() => new FilesystemHyperQueueObservationOrder(corruptPath)).toThrow(
      "hyperqueue_observation_order_corrupt",
    );

    const swapDirectory = await temporaryDirectory("wf-hq-order-swap");
    const swapPath = join(swapDirectory, "observation.wal");
    const guarded = new FilesystemHyperQueueObservationOrder(swapPath);
    await guarded.next("dispatch-observation");
    await rename(swapPath, `${swapPath}.replaced`);
    await writeFile(swapPath, "", { flag: "wx", mode: 0o600 });
    await chmod(swapPath, 0o600);
    await expect(guarded.next("dispatch-observation")).rejects.toThrow(
      "hyperqueue_observation_order_identity_changed",
    );
  });

  it("recovers an interrupted derived checkpoint from the durable WAL", async () => {
    const directory = await temporaryDirectory("wf-hq-order-checkpoint");
    const path = join(directory, "observation.wal");
    const first = new FilesystemHyperQueueObservationOrder(path);
    await first.next("dispatch-observation");
    await writeFile(`${path}.checkpoint.tmp`, "interrupted", {
      flag: "wx",
      mode: 0o600,
    });
    const recovered = new FilesystemHyperQueueObservationOrder(path);
    await expect(recovered.next("dispatch-observation")).resolves.toEqual({
      sourceEpoch: 1,
      sourceSequence: 2,
    });
  });
});
