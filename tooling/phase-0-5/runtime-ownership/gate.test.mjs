import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SyntheticRuntimeJournal, decideRuntimeOwnership } from "./gate.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Phase 0.5 foreground synthetic runtime", () => {
  it("returns the durable receipt for a duplicate request without another effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-feasibility-runtime-"));
    temporaryDirectories.push(directory);
    const journal = new SyntheticRuntimeJournal(
      join(directory, "receipts.jsonl"),
    );
    let effects = 0;
    const effect = () => {
      effects += 1;
      return Promise.resolve("synthetic-result");
    };

    await expect(
      journal.dispatch("operation-1", effect),
    ).resolves.toMatchObject({
      duplicate: false,
      status: "confirmed",
    });
    await expect(journal.dispatch("operation-1", effect)).resolves.toEqual({
      duplicate: true,
      operationId: "operation-1",
      result: "synthetic-result",
      status: "confirmed",
    });
    expect(effects).toBe(1);
  });

  it("recovers a post-receipt crash as a duplicate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-feasibility-runtime-"));
    temporaryDirectories.push(directory);
    const journal = new SyntheticRuntimeJournal(
      join(directory, "receipts.jsonl"),
    );

    await expect(
      journal.dispatch(
        "operation-2",
        () => Promise.resolve("done"),
        "after_receipt",
      ),
    ).rejects.toThrow("synthetic crash");
    await expect(
      journal.dispatch("operation-2", () =>
        Promise.reject(new Error("replayed")),
      ),
    ).resolves.toMatchObject({
      duplicate: true,
      result: "done",
      status: "confirmed",
    });
  });

  it("does not blindly replay an effect with an ambiguous missing receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wf-feasibility-runtime-"));
    temporaryDirectories.push(directory);
    const journal = new SyntheticRuntimeJournal(
      join(directory, "receipts.jsonl"),
    );
    let effects = 0;

    await expect(
      journal.dispatch(
        "operation-3",
        () => {
          effects += 1;
          return Promise.resolve("effect-finished");
        },
        "after_effect_before_receipt",
      ),
    ).rejects.toThrow("ambiguous synthetic crash");
    await expect(
      journal.dispatch("operation-3", () => {
        effects += 1;
        return Promise.resolve("replayed");
      }),
    ).resolves.toEqual({
      duplicate: true,
      operationId: "operation-3",
      status: "reconciliation_required",
    });
    expect(effects).toBe(1);
  });

  it("does not claim host ownership without the outer systemd evidence", () => {
    expect(
      decideRuntimeOwnership({
        duplicateReceipt: true,
        foregroundChild: true,
        noDaemonEscape: true,
        outerBoundaryVerified: false,
      }),
    ).toMatchObject({ productionGate: "closed", status: "unsupported" });
  });
});
