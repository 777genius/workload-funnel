import { createHash } from "node:crypto";
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

import {
  DurableObservationSpool,
  FilesystemObservationSpoolStorage,
  ObservationSpoolError,
  type ObservationSpoolStorage,
  type SpooledObservation,
} from "@workload-funnel/node-execution/observation-spooling";
import {
  InvalidPartitionPolicyError,
  decideControlPartition,
} from "@workload-funnel/node-execution/process-lifecycle";
import {
  FenceInstallIssueCoordinator,
  FenceInstallIssueError,
  reconcileUnknownExecution,
  type Execution,
} from "@workload-funnel/workload-control/execution-reconciliation";
import {
  fingerprintMutationFence,
  serializeMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

class MemorySpoolStorage implements ObservationSpoolStorage {
  public readonly lines: string[] = [];
  public failNextAppend = false;

  public constructor(public readonly capacity = 20) {}

  public appendAndSync(serializedRecord: string): void {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("synthetic spool fsync failure");
    }
    this.lines.push(serializedRecord);
  }

  public readAll(): readonly string[] {
    return [...this.lines];
  }
}

function observation(
  overrides: Partial<SpooledObservation> = {},
): SpooledObservation {
  return {
    bootEpoch: 1,
    eventId: "observation-1",
    executionGeneration: "generation-1",
    executionId: "execution-1",
    kind: "observation",
    nodeId: "node-1",
    observedAtMs: 1_500,
    payloadDigest: "a".repeat(64),
    sourceSequence: 1,
    state: "active",
    ...overrides,
  };
}

function execution(): Execution {
  return {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    dispatchId: "dispatch-1",
    executionGeneration: "generation-1",
    executionId: "execution-1",
    observationSequence: 4,
    state: "unknown",
    version: 4,
  };
}

function fence(): MutationFence {
  return {
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "namespace-1.process-start.attempt-1.generation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "namespace-1",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    notAfter: 2_000,
    notBefore: 1_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "desired-start-1",
  };
}

describe("Phase 4B node recovery and partition policy", () => {
  it("durably replays observations after acknowledgement loss", () => {
    const storage = new MemorySpoolStorage();
    const first = new DurableObservationSpool(storage);
    first.append(observation());
    first.append(observation());
    expect(first.pending).toHaveLength(1);

    const publications: string[] = [];
    storage.failNextAppend = true;
    expect(() =>
      first.publishPending((event) => {
        publications.push(event.eventId);
        return "publication-1";
      }),
    ).toThrow(ObservationSpoolError);
    expect(publications).toEqual(["observation-1"]);
    expect(first.cordonReason).toBe("observation_spool_corrupt");

    const restarted = new DurableObservationSpool(storage);
    expect(restarted.pending).toEqual([observation()]);
    expect(
      restarted.publishPending((event) => {
        publications.push(event.eventId);
        return "publication-1";
      }),
    ).toBe(1);
    expect(publications).toEqual(["observation-1", "observation-1"]);
    expect(new DurableObservationSpool(storage).pending).toHaveLength(0);
  });

  it("cordons on spool corruption, identity collision, and bounded saturation", () => {
    const collisionStorage = new MemorySpoolStorage();
    const collision = new DurableObservationSpool(collisionStorage);
    collision.append(observation());
    expect(() => {
      collision.append(observation({ state: "failed" }));
    }).toThrow(ObservationSpoolError);
    expect(collision.cordonReason).toBe("observation_spool_corrupt");

    const corruptStorage = new MemorySpoolStorage();
    new DurableObservationSpool(corruptStorage).append(observation());
    const corruptLine = corruptStorage.lines.at(0);
    if (corruptLine === undefined) throw new Error("synthetic spool is empty");
    corruptStorage.lines[0] = `${corruptLine}tampered`;
    const corrupt = new DurableObservationSpool(corruptStorage);
    expect(corrupt.cordonReason).toBe("observation_spool_corrupt");
    expect(corrupt.pending).toHaveLength(0);

    const full = new DurableObservationSpool(new MemorySpoolStorage(1));
    expect(() => {
      full.append(observation());
    }).toThrow(ObservationSpoolError);
    expect(full.cordonReason).toBe("observation_spool_full");
  });

  it("reopens and cordons disposable filesystem spools after damage or fullness", () => {
    const root = mkdtempSync(join(tmpdir(), "workload-funnel-spool-"));
    try {
      const directory = join(root, "reopen");
      new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({ capacity: 10, directory }),
      ).append(observation());
      const afterCrash = new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({ capacity: 10, directory }),
      );
      expect(afterCrash.pending).toEqual([observation()]);
      afterCrash.acknowledge({
        eventId: "observation-1",
        publicationId: "publication-1",
      });
      expect(
        new DurableObservationSpool(
          new FilesystemObservationSpoolStorage({ capacity: 10, directory }),
        ).pending,
      ).toHaveLength(0);

      const ledger = join(directory, "observations.spool");
      truncateSync(ledger, readFileSync(ledger).byteLength - 1);
      expect(
        new DurableObservationSpool(
          new FilesystemObservationSpoolStorage({ capacity: 10, directory }),
        ).cordonReason,
      ).toBe("observation_spool_corrupt");

      const corruptDirectory = join(root, "corrupt");
      new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({
          capacity: 10,
          directory: corruptDirectory,
        }),
      ).append(observation());
      const corruptLedger = join(corruptDirectory, "observations.spool");
      const bytes = readFileSync(corruptLedger);
      const corruptIndex = Math.floor(bytes.byteLength / 2);
      bytes[corruptIndex] = (bytes[corruptIndex] ?? 0) ^ 1;
      writeFileSync(corruptLedger, bytes);
      expect(
        new DurableObservationSpool(
          new FilesystemObservationSpoolStorage({
            capacity: 10,
            directory: corruptDirectory,
          }),
        ).cordonReason,
      ).toBe("observation_spool_corrupt");

      const full = new DurableObservationSpool(
        new FilesystemObservationSpoolStorage({
          capacity: 1,
          directory: join(root, "full"),
        }),
      );
      expect(() => {
        full.append(observation());
      }).toThrow(ObservationSpoolError);
      expect(full.cordonReason).toBe("observation_spool_full");

      const bounded = new FilesystemObservationSpoolStorage({
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

  it("persists terminal result facts without storing child output", () => {
    const storage = new MemorySpoolStorage();
    const terminal = observation({
      eventId: "terminal-result-1",
      kind: "terminal_result",
      payloadDigest: "b".repeat(64),
      sourceSequence: 2,
      state: "exited",
    });
    new DurableObservationSpool(storage).append(terminal);
    const restarted = new DurableObservationSpool(storage);
    expect(restarted.pending).toEqual([terminal]);
    expect(JSON.stringify(storage.lines)).not.toContain("child output");
    expect(restarted.publishPending(() => "terminal-publication-1")).toBe(1);
    expect(new DurableObservationSpool(storage).pending).toHaveLength(0);
  });

  it("reconciles unknown only from exact durable evidence", () => {
    expect(
      reconcileUnknownExecution(execution(), {
        inventoryState: "active",
        invocationIdentityMatches: true,
        journalAvailable: false,
        launcherWalState: "started_or_unknown",
      }),
    ).toEqual({
      nextState: "running",
      replacementAllowed: false,
      result: "converged",
    });
    expect(
      reconcileUnknownExecution(execution(), {
        inventoryState: "absent",
        invocationIdentityMatches: true,
        journalAvailable: false,
        launcherWalState: "systemd_call_issued",
      }),
    ).toEqual({
      nextState: "unknown",
      replacementAllowed: false,
      result: "ambiguous",
    });
    expect(
      reconcileUnknownExecution(execution(), {
        inventoryState: "absent",
        invocationIdentityMatches: true,
        journalAvailable: true,
        launcherWalState: "redeemed",
      }),
    ).toEqual({
      nextState: "lost",
      replacementAllowed: true,
      result: "absence_proven",
    });
    expect(
      reconcileUnknownExecution(execution(), {
        inventoryState: "active",
        invocationIdentityMatches: false,
        journalAvailable: true,
        launcherWalState: "started_or_unknown",
      }).result,
    ).toBe("cordon");
    expect(
      reconcileUnknownExecution(execution(), {
        inventoryState: "unknown",
        invocationIdentityMatches: false,
        journalAvailable: false,
        launcherWalState: "started_or_unknown",
        spoolExecutionGeneration: "generation-1",
        spoolTerminalState: "exited",
      }),
    ).toMatchObject({ nextState: "exited", result: "converged" });
  });

  it("applies every partition policy without admitting or replaying work", () => {
    const common = {
      capabilities: { externalFenceEnforced: false },
      disconnectedForMs: 9_000,
      executionDeadlineMs: 20_000,
      graceMs: 10_000,
      nowMs: 15_000,
      replayClass: "side_effectful" as const,
    };
    expect(
      decideControlPartition({
        ...common,
        policy: "terminate_after_grace",
      }),
    ).toMatchObject({
      acceptNewWork: false,
      action: "continue_existing",
      replacementBlocked: true,
    });
    expect(
      decideControlPartition({
        ...common,
        disconnectedForMs: 10_000,
        policy: "terminate_after_grace",
      }).action,
    ).toBe("stop_existing");
    expect(
      decideControlPartition({
        ...common,
        policy: "continue_until_deadline",
      }),
    ).toMatchObject({
      acceptNewWork: false,
      action: "continue_existing",
      replacementBlocked: true,
    });
    expect(() =>
      decideControlPartition({ ...common, policy: "executor_fenced" }),
    ).toThrow(InvalidPartitionPolicyError);
    expect(
      decideControlPartition({
        ...common,
        capabilities: { externalFenceEnforced: true },
        policy: "executor_fenced",
      }).reason,
    ).toBe("fenced_executor_continuation");
    expect(
      decideControlPartition({
        ...common,
        executionDeadlineMs: 15_000,
        policy: "continue_until_deadline",
      }).action,
    ).toBe("stop_existing");
  });

  it("uses SHA-256 full-tuple fingerprints and gates issue on durable install ack", () => {
    const completeFence = fence();
    const expected = createHash("sha256")
      .update(serializeMutationFence(completeFence), "utf8")
      .digest("hex");
    expect(fingerprintMutationFence(completeFence)).toBe(
      `fence-v1-${expected}`,
    );

    const coordinator = new FenceInstallIssueCoordinator();
    const pending = {
      desiredVersion: 1,
      effectScopeKey: completeFence.effectScopeKey,
      installOperationId: "install-1",
      mutationFenceFingerprint: fingerprintMutationFence(completeFence),
    };
    coordinator.plan(pending);
    const effects: string[] = [];
    expect(() =>
      coordinator.issue(pending.effectScopeKey, () => effects.push("start")),
    ).toThrow(FenceInstallIssueError);
    coordinator.acknowledge({ ...pending, walSequence: 7 });
    expect(
      coordinator.issue(pending.effectScopeKey, () => effects.push("start")),
    ).toBe(1);
    expect(effects).toEqual(["start"]);
    coordinator.plan({
      ...pending,
      desiredVersion: 2,
      installOperationId: "install-2",
    });
    expect(() =>
      coordinator.issue(pending.effectScopeKey, () => effects.push("stale")),
    ).toThrow(FenceInstallIssueError);
  });
});
