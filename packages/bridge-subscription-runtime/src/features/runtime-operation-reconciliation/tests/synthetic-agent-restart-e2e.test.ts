import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  TargetExecutionTicket,
  TargetTerminalInput,
} from "@workload-funnel/node-execution/process-lifecycle";
import { describe, expect, it } from "vitest";

import { createProvider as createEventSource } from "../../runtime-event-consumption/index.js";
import { createProvider as createResultTranslator } from "../../runtime-result-translation/index.js";
import { createProvider as createTicketPreparer } from "../../execution-ticket-preparation/index.js";
import {
  DurableRuntimeDispatcher,
  FilesystemRuntimeOperationStore,
} from "../../runtime-operation-dispatch/index.js";
import {
  asReconciliationClient,
  createSyntheticAuthorityGrant,
  createSyntheticRuntimeStorage,
  SyntheticRuntimeBroker,
} from "../../runtime-operation-dispatch/tests/synthetic-runtime-fixture.js";
import {
  DurableRuntimeReconciler,
  FilesystemRuntimeReconciliationStore,
} from "../index.js";

function fence(): MutationFence {
  return {
    schemaVersion: 1,
    clusterIncarnationVersion: 1,
    clusterIncarnation: "synthetic-e2e-cluster",
    namespaceId: "test://phase6/e2e",
    namespaceWriterEpoch: 1,
    operationGateRevision: 1,
    requiredGate: "process_start",
    attemptId: "synthetic-agent-attempt",
    executionGeneration: "synthetic-agent-generation",
    allocationId: "synthetic-agent-allocation",
    ownerFence: 1,
    desiredEffect: "process_start",
    expectedDesiredVersion: 1,
    supersessionKey: "synthetic-agent-start",
    effectScopeKey: "runtime:synthetic-agent-attempt",
    startFence: "synthetic-agent-start-fence",
    issuedStartRevocationRevision: 0,
    nodeId: "synthetic-node",
    nodeBootEpoch: 1,
    notBefore: 1_000,
    notAfter: 100_000,
  };
}

function ticket(): TargetExecutionTicket {
  const mutationFence = fence();
  return {
    causationId: "synthetic-e2e-cause",
    correlationId: "synthetic-e2e-correlation",
    expiresAtMs: 100_000,
    idempotencyKey: "synthetic-e2e-idempotency",
    issuedAtMs: 1_000,
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    operationId: "synthetic-e2e-operation",
    projectId: "disposable-synthetic-project",
    requestId: "synthetic-e2e-request",
    runtimeTargetId: "synthetic-e2e-runtime",
    sandboxProfileDigest: "c".repeat(64),
    ticketId: "synthetic-e2e-ticket",
  };
}

async function install(
  dispatcher: DurableRuntimeDispatcher,
  changeId: string,
): Promise<void> {
  const mutationFence = fence();
  const closeAcknowledgement = await dispatcher.closeAuthority({
    changeId,
    effectScopeKey: mutationFence.effectScopeKey,
    targetId: "synthetic-e2e-runtime",
  });
  const acknowledgement = await dispatcher.installAuthority({
    closeAcknowledgement,
    grant: createSyntheticAuthorityGrant(
      mutationFence,
      changeId,
      "synthetic-e2e-runtime",
    ),
  });
  await dispatcher.reopenAuthority(acknowledgement);
}

describe("Phase 6 synthetic agent-run restart E2E", () => {
  it("survives bridge and runtime restart, resumes the cursor, and maps terminal result without another start", async () => {
    const root = mkdtempSync(join(tmpdir(), "workload-funnel-phase6-e2e-"));
    try {
      const runtimeDirectory = join(root, "runtime");
      const operationDirectory = join(root, "operations");
      const reconciliationDirectory = join(root, "reconciliation");
      const runtimeStorage = createSyntheticRuntimeStorage(runtimeDirectory);
      const runtime = new SyntheticRuntimeBroker(runtimeStorage, {
        controllerId: "synthetic-e2e-controller",
      });
      runtime.recover();
      const bridgeStore = new FilesystemRuntimeOperationStore({
        capacity: 16,
        directory: operationDirectory,
      });
      const dispatcher = new DurableRuntimeDispatcher({
        client: runtime,
        store: bridgeStore,
      });
      await install(dispatcher, "synthetic-e2e-initial-install");
      const prepared = createTicketPreparer().prepare(ticket());
      const receipt = await dispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: prepared,
      });
      expect(receipt.state).toBe("accepted");
      runtime.appendRunState(prepared.idempotencyKey, "running");

      const firstSource = createEventSource({
        client: runtime,
        controllerId: "synthetic-e2e-controller",
        targetId: prepared.runtimeTargetId,
      });
      const reconciliationStore = new FilesystemRuntimeReconciliationStore({
        capacity: 16,
        directory: reconciliationDirectory,
      });
      const firstReconciler = new DurableRuntimeReconciler({
        client: asReconciliationClient(firstSource),
        eventPageSize: 1,
        store: reconciliationStore,
      });
      const beforeRestart = await firstReconciler.reconcile();
      expect(beforeRestart.observations).toHaveLength(1);
      expect(beforeRestart.observations[0]?.state).toBe("running");

      const restartedRuntimeStorage =
        createSyntheticRuntimeStorage(runtimeDirectory);
      const restartedRuntime = new SyntheticRuntimeBroker(
        restartedRuntimeStorage,
        { controllerId: "synthetic-e2e-controller" },
      );
      const restartedBridgeStore = new FilesystemRuntimeOperationStore({
        capacity: 16,
        directory: operationDirectory,
      });
      const restartedDispatcher = new DurableRuntimeDispatcher({
        client: restartedRuntime,
        store: restartedBridgeStore,
      });
      await expect(
        restartedDispatcher.dispatch({
          boundary: "runtime",
          kind: "start",
          ticket: prepared,
        }),
      ).resolves.toEqual(receipt);
      expect(restartedRuntime.capabilityDiscoveryCalls).toBe(0);
      restartedRuntime.recover(fence());
      await install(restartedDispatcher, "synthetic-e2e-recovery-install");
      await expect(
        restartedDispatcher.dispatch({
          boundary: "runtime",
          kind: "start",
          ticket: prepared,
        }),
      ).resolves.toEqual(receipt);
      expect(restartedRuntimeStorage.finalMutationCalls).toBe(1);

      const resultDigest = "d".repeat(64);
      restartedRuntime.appendRunState(prepared.idempotencyKey, "exited", {
        completedAtMs: 9_000,
        exitCode: 0,
        outcome: "succeeded",
        resultDigest,
      });
      const restartedSource = createEventSource({
        client: restartedRuntime,
        controllerId: "synthetic-e2e-controller",
        targetId: prepared.runtimeTargetId,
      });
      const reopenedReconciliationStore =
        new FilesystemRuntimeReconciliationStore({
          capacity: 16,
          directory: reconciliationDirectory,
        });
      const restartedReconciler = new DurableRuntimeReconciler({
        client: asReconciliationClient(restartedSource),
        eventPageSize: 1,
        store: reopenedReconciliationStore,
      });
      const afterRestart = await restartedReconciler.reconcile();
      expect(afterRestart.conflicts).toEqual([]);
      expect(afterRestart.observations).toHaveLength(1);
      const terminal = afterRestart.observations[0]?.terminal;
      expect(afterRestart.observations[0]?.state).toBe("exited");
      expect(terminal).toBeDefined();
      if (terminal === undefined)
        throw new Error("terminal observation missing");
      expect(createResultTranslator().translateTerminal(terminal)).toEqual({
        classification: "succeeded",
        completedAtMs: 9_000,
        exitCode: 0,
        resultDigest,
      });
      expect(restartedRuntimeStorage.finalMutationCalls).toBe(1);

      appendFileSync(
        join(operationDirectory, "runtime-operations.wal"),
        "{corrupt}\n",
      );
      expect(
        () =>
          new FilesystemRuntimeOperationStore({
            capacity: 16,
            directory: operationDirectory,
          }),
      ).toThrow();
      appendFileSync(
        join(reconciliationDirectory, "runtime-reconciliation.wal"),
        "{corrupt}\n",
      );
      expect(
        () =>
          new FilesystemRuntimeReconciliationStore({
            capacity: 16,
            directory: reconciliationDirectory,
          }),
      ).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("maps typed provider capacity without embedding retry policy", () => {
    const translator = createResultTranslator();
    expect(
      translator.translateCapacity({
        observedAtMs: 2_000,
        retryAfterMs: 30_000,
        state: "quota_exhausted",
      }),
    ).toEqual({
      availableSlots: 0,
      classification: "temporarily_exhausted",
      observedAtMs: 2_000,
      retryAfterMs: 30_000,
    });
    expect(
      translator.translateCapacity({
        availableSlots: 4,
        observedAtMs: 3_000,
        state: "available",
      }),
    ).toEqual({
      availableSlots: 4,
      classification: "available",
      observedAtMs: 3_000,
    });
  });

  it("quarantines every contradictory terminal combination and never derives success", async () => {
    const targetId = "synthetic-terminal-target";
    const controllerId = "synthetic-terminal-controller";
    const rawEvents = [
      {
        state: "exited",
        terminal: {
          completedAtMs: 10,
          exitCode: 1,
          outcome: "succeeded",
          resultDigest: "e".repeat(64),
        },
      },
      {
        state: "exited",
        terminal: {
          completedAtMs: 11,
          exitCode: 0,
          failureCode: "provider_failed",
          outcome: "failed",
        },
      },
      {
        state: "stopped",
        terminal: {
          completedAtMs: 12,
          exitCode: 0,
          outcome: "succeeded",
          resultDigest: "f".repeat(64),
        },
      },
      {
        state: "exited",
        terminal: { completedAtMs: 13, outcome: "invented" },
      },
      { state: "exited" },
    ].map((entry, index) => ({
      causationId: `cause-${String(index)}`,
      controllerId,
      cursor: `cursor-${String(index + 1)}`,
      operationId: `operation-${String(index)}`,
      projectId: "synthetic-terminal-project",
      runtimeBuildSha: "a".repeat(40),
      runtimeOperationId: `runtime-operation-${String(index)}`,
      schemaVersion: "subscription-runtime.event.v1",
      sourceRevision: index + 1,
      targetId,
      ...entry,
    }));
    const source = createEventSource({
      client: {
        readEvents: () =>
          Promise.resolve({
            events: rawEvents,
            schemaVersion: "subscription-runtime.event-page.v1",
          }),
        readProjectSnapshot: () =>
          Promise.resolve({
            entries: rawEvents,
            schemaVersion: "subscription-runtime.snapshot-page.v1",
          }),
      },
      controllerId,
      targetId,
    });
    const parsed = await source.readEvents(undefined, rawEvents.length);
    expect(parsed.events).toHaveLength(rawEvents.length);
    expect(parsed.events.every((event) => event.state === "quarantined")).toBe(
      true,
    );
    expect(parsed.events.every((event) => event.terminal === undefined)).toBe(
      true,
    );
    await expect(source.readEvents(undefined, 2)).rejects.toThrow(
      /runtime_page_malformed/u,
    );

    const translator = createResultTranslator();
    const contradictory = [
      {
        completedAtMs: 1,
        exitCode: 1,
        outcome: "succeeded",
        resultDigest: "a".repeat(64),
      },
      {
        completedAtMs: 1,
        exitCode: 0,
        failureCode: "failed",
        outcome: "failed",
      },
      {
        cancellationCode: "canceled",
        completedAtMs: 1,
        exitCode: 0,
        outcome: "canceled",
      },
    ] as unknown as readonly TargetTerminalInput[];
    for (const terminalInput of contradictory) {
      expect(translator.translateTerminal(terminalInput)).toMatchObject({
        classification: "quarantined",
      });
    }
  });
});
