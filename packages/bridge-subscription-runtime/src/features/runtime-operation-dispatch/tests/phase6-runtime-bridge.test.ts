import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type {
  PreparedTargetTicket,
  TargetExecutionTicket,
} from "@workload-funnel/node-execution/process-lifecycle";
import { describe, expect, it } from "vitest";

import { createProvider as createCapabilityProvider } from "../../runtime-capability-discovery/index.js";
import { createProvider as createTicketPreparer } from "../../execution-ticket-preparation/index.js";
import {
  DurableRuntimeDispatcher,
  RUNTIME_BROKER_CONTRACT_VERSION,
  type RuntimeMutationRequestV1,
} from "../index.js";
import {
  createSyntheticAuthorityGrant,
  createSyntheticRuntimeStorage,
  InMemoryRuntimeOperationStore,
  SyntheticRuntimeBroker,
} from "./synthetic-runtime-fixture.js";

const targetId = "synthetic-runtime-target";

function fence(overrides: Partial<MutationFence> = {}): MutationFence {
  return {
    schemaVersion: 1,
    clusterIncarnationVersion: 3,
    clusterIncarnation: "cluster-three",
    namespaceId: "test://phase6/synthetic",
    namespaceWriterEpoch: 5,
    operationGateRevision: 7,
    requiredGate: "process_start",
    attemptId: "attempt-phase6",
    executionGeneration: "generation-phase6",
    allocationId: "allocation-phase6",
    ownerFence: 11,
    desiredEffect: "process_start",
    expectedDesiredVersion: 13,
    supersessionKey: "runtime-start-phase6",
    effectScopeKey: "runtime:attempt-phase6:generation-phase6",
    startFence: "start-fence-phase6",
    issuedStartRevocationRevision: 17,
    nodeId: "node-phase6",
    nodeBootEpoch: 19,
    notBefore: 100,
    notAfter: 10_000,
    ...overrides,
  };
}

function targetTicket(
  mutationFence = fence(),
  suffix = "phase6",
): TargetExecutionTicket {
  return {
    causationId: "cause-phase6",
    correlationId: "correlation-phase6",
    expiresAtMs: mutationFence.notAfter ?? 10_000,
    idempotencyKey: `idempotency-${suffix}`,
    issuedAtMs: mutationFence.notBefore ?? 100,
    mutationFence,
    mutationFenceFingerprint: fingerprintMutationFence(mutationFence),
    operationId: `operation-${suffix}`,
    projectId: "synthetic-project",
    requestId: `request-${suffix}`,
    runtimeTargetId: targetId,
    sandboxProfileDigest: "b".repeat(64),
    ticketId: `ticket-${suffix}`,
  };
}

async function install(
  dispatcher: DurableRuntimeDispatcher,
  mutationFence: MutationFence,
  changeId: string,
  reopen = true,
): Promise<void> {
  const closeAcknowledgement = await dispatcher.closeAuthority({
    changeId,
    effectScopeKey: mutationFence.effectScopeKey,
    targetId,
  });
  const acknowledgement = await dispatcher.installAuthority({
    closeAcknowledgement,
    grant: createSyntheticAuthorityGrant(mutationFence, changeId, targetId),
  });
  if (reopen) await dispatcher.reopenAuthority(acknowledgement);
}

function mutateAtBoundary(
  broker: SyntheticRuntimeBroker,
  request: RuntimeMutationRequestV1,
) {
  switch (request.boundary) {
    case "runtime":
      return broker.finalMutators.runtime.mutate({
        ...request,
        boundary: "runtime",
      });
    case "provider":
      return broker.finalMutators.provider.mutate({
        ...request,
        boundary: "provider",
      });
    case "session":
      return broker.finalMutators.session.mutate({
        ...request,
        boundary: "session",
      });
  }
}

function requestWithFence(
  request: RuntimeMutationRequestV1,
  mutationFence: MutationFence,
  suffix: string,
  boundary: RuntimeMutationRequestV1["boundary"],
): RuntimeMutationRequestV1 {
  const mutationFenceFingerprint = fingerprintMutationFence(mutationFence);
  return {
    ...request,
    boundary,
    idempotencyKey: `${request.idempotencyKey}-${suffix}-${boundary}`,
    intentFingerprint: `${request.intentFingerprint}-${suffix}-${boundary}`,
    mutationFence,
    mutationFenceFingerprint,
    operationId: `${request.operationId}-${suffix}-${boundary}`,
    ticket: {
      ...request.ticket,
      mutationFence,
      mutationFenceFingerprint,
      operationId: `${request.operationId}-${suffix}-${boundary}`,
    },
  };
}

function fenceWithoutAllocation(): MutationFence {
  const result = { ...fence() } as Record<string, unknown>;
  Reflect.deleteProperty(result, "allocationId");
  Reflect.deleteProperty(result, "ownerFence");
  return result as unknown as MutationFence;
}

function fenceWithoutNode(): MutationFence {
  const result = { ...fence() } as Record<string, unknown>;
  Reflect.deleteProperty(result, "nodeBootEpoch");
  Reflect.deleteProperty(result, "nodeId");
  return result as unknown as MutationFence;
}

async function readyRuntime(): Promise<{
  readonly broker: SyntheticRuntimeBroker;
  readonly dispatcher: DurableRuntimeDispatcher;
  readonly preparedTicket: PreparedTargetTicket;
  readonly storage: ReturnType<typeof createSyntheticRuntimeStorage>;
  readonly store: InMemoryRuntimeOperationStore;
}> {
  const storage = createSyntheticRuntimeStorage();
  const broker = new SyntheticRuntimeBroker(storage);
  broker.recover();
  const store = new InMemoryRuntimeOperationStore();
  const dispatcher = new DurableRuntimeDispatcher({ client: broker, store });
  await install(dispatcher, fence(), "install-initial");
  return {
    broker,
    dispatcher,
    preparedTicket: createTicketPreparer().prepare(targetTicket()),
    storage,
    store,
  };
}

describe("Phase 6 capability, ticket, and durable dispatch", () => {
  it("refuses an incapable target before any bridge, registry, or final mutation", async () => {
    const storage = createSyntheticRuntimeStorage();
    const broker = new SyntheticRuntimeBroker(storage, {
      supportsFencing: false,
    });
    broker.recover();
    const store = new InMemoryRuntimeOperationStore();
    const dispatcher = new DurableRuntimeDispatcher({ client: broker, store });
    const discovery = createCapabilityProvider({
      discoverCapabilities: (id) => broker.discoverCapabilities(id),
    });

    await expect(discovery.discover(targetId, "start")).resolves.toMatchObject({
      reason: "required_fencing_unsupported",
      status: "incapable",
    });
    const receipt = await dispatcher.dispatch({
      boundary: "runtime",
      kind: "start",
      ticket: createTicketPreparer().prepare(targetTicket()),
    });
    expect(receipt).toMatchObject({
      rejectionCode: "required_fencing_unsupported",
      state: "rejected",
    });
    expect(store.mutationCount).toBe(0);
    expect(storage.registryMutations).toBe(0);
    expect(storage.finalMutationCalls).toBe(0);
  });

  it("translates a closed ticket and prevents duplicate start across bridge and runtime restart", async () => {
    const { broker, dispatcher, preparedTicket, storage, store } =
      await readyRuntime();
    expect(preparedTicket).toMatchObject({
      executionMode: "foreground",
      schemaVersion: "subscription-runtime.execution-ticket.v1",
    });
    const first = await dispatcher.dispatch({
      boundary: "runtime",
      kind: "start",
      ticket: preparedTicket,
    });
    expect(first.state).toBe("accepted");
    expect(storage.finalMutationCalls).toBe(1);

    const restartedBroker = new SyntheticRuntimeBroker(storage);
    const restartedStore = new InMemoryRuntimeOperationStore(
      store.durableRecords,
    );
    const restartedDispatcher = new DurableRuntimeDispatcher({
      client: restartedBroker,
      store: restartedStore,
    });
    await expect(
      restartedDispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: preparedTicket,
      }),
    ).resolves.toEqual(first);
    expect(restartedBroker.capabilityDiscoveryCalls).toBe(0);
    restartedBroker.recover(fence());
    await install(restartedDispatcher, fence(), "recover-runtime");
    const replay = await restartedDispatcher.dispatch({
      boundary: "runtime",
      kind: "start",
      ticket: preparedTicket,
    });
    expect(replay).toEqual(first);
    expect(storage.finalMutationCalls).toBe(1);
    expect(broker).toBeDefined();
  });

  it("recovers a lost mutation response by durable lookup without a second start", async () => {
    const { broker, dispatcher, preparedTicket, storage } =
      await readyRuntime();
    broker.failAfterFinalMutationOnce = true;
    await expect(
      dispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: preparedTicket,
      }),
    ).resolves.toMatchObject({ state: "accepted" });
    expect(storage.finalMutationCalls).toBe(1);
    await expect(
      dispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: preparedTicket,
      }),
    ).resolves.toMatchObject({ state: "accepted" });
    expect(storage.finalMutationCalls).toBe(1);
  });

  it("keeps an operation unknown and makes no broker call when prior-operation lookup is unavailable", async () => {
    const { broker, dispatcher, preparedTicket, storage, store } =
      await readyRuntime();
    broker.operationLookupAvailable = false;
    await expect(
      dispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: preparedTicket,
      }),
    ).resolves.toEqual({
      mutationFenceFingerprint: preparedTicket.mutationFenceFingerprint,
      operationId: preparedTicket.operationId,
      state: "unknown",
    });
    expect(storage.finalMutationCalls).toBe(0);
    expect(store.durableRecords.get(preparedTicket.idempotencyKey)?.state).toBe(
      "unknown",
    );
  });
});

describe("Phase 6 runtime broker final-boundary fencing", () => {
  it("authenticates canonical grants and persists cross-scope high-watermarks across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "workload-funnel-phase6-fence-"));
    try {
      const storage = createSyntheticRuntimeStorage(root);
      const broker = new SyntheticRuntimeBroker(storage);
      broker.recover();
      const dispatcher = new DurableRuntimeDispatcher({
        client: broker,
        store: new InMemoryRuntimeOperationStore(),
      });
      await install(dispatcher, fence(), "baseline-authority");

      const crossScope = fence({
        allocationId: "allocation-cross-scope",
        attemptId: "attempt-cross-scope",
        effectScopeKey: "runtime:attempt-cross-scope:generation-cross-scope",
        executionGeneration: "generation-cross-scope",
        startFence: "start-fence-cross-scope",
        supersessionKey: "runtime-start-cross-scope",
      });
      const closeAcknowledgement = await dispatcher.closeAuthority({
        changeId: "cross-scope-authority",
        effectScopeKey: crossScope.effectScopeKey,
        targetId,
      });
      const mutationsAfterClose = storage.registryMutations;
      const authenticGrant = createSyntheticAuthorityGrant(
        crossScope,
        "cross-scope-authority",
        targetId,
      );
      await expect(
        dispatcher.installAuthority({
          closeAcknowledgement,
          grant: { ...authenticGrant, signature: "0".repeat(64) },
        }),
      ).rejects.toThrow(/signature/u);
      expect(storage.registryMutations).toBe(mutationsAfterClose);

      const incompleteFence = { ...crossScope } as Record<string, unknown>;
      Reflect.deleteProperty(incompleteFence, "allocationId");
      Reflect.deleteProperty(incompleteFence, "ownerFence");
      await expect(
        dispatcher.installAuthority({
          closeAcknowledgement,
          grant: createSyntheticAuthorityGrant(
            incompleteFence as unknown as MutationFence,
            "cross-scope-authority",
            targetId,
          ),
        }),
      ).rejects.toThrow(/incomplete/u);
      expect(storage.registryMutations).toBe(mutationsAfterClose);

      for (const rejectedFence of [
        { ...crossScope, clusterIncarnationVersion: 2 },
        { ...crossScope, clusterIncarnation: "equal-version-other-cluster" },
      ]) {
        await expect(
          dispatcher.installAuthority({
            closeAcknowledgement,
            grant: createSyntheticAuthorityGrant(
              rejectedFence,
              "cross-scope-authority",
              targetId,
            ),
          }),
        ).rejects.toThrow(/lower_cluster|equal_mismatch_cluster/u);
        expect(storage.registryMutations).toBe(mutationsAfterClose);
      }

      const acknowledgement = await dispatcher.installAuthority({
        closeAcknowledgement,
        grant: authenticGrant,
      });
      await dispatcher.reopenAuthority(acknowledgement);

      const restartedStorage = createSyntheticRuntimeStorage(root);
      const restarted = new SyntheticRuntimeBroker(restartedStorage);
      restarted.recover(fence());
      const restartedDispatcher = new DurableRuntimeDispatcher({
        client: restarted,
        store: new InMemoryRuntimeOperationStore(),
      });
      const thirdScope = {
        ...crossScope,
        allocationId: "allocation-third-scope",
        attemptId: "attempt-third-scope",
        effectScopeKey: "runtime:attempt-third-scope:generation-third-scope",
        executionGeneration: "generation-third-scope",
        startFence: "start-fence-third-scope",
        supersessionKey: "runtime-start-third-scope",
      };
      const restartedClose = await restartedDispatcher.closeAuthority({
        changeId: "restart-lower-authority",
        effectScopeKey: thirdScope.effectScopeKey,
        targetId,
      });
      await expect(
        restartedDispatcher.installAuthority({
          closeAcknowledgement: restartedClose,
          grant: createSyntheticAuthorityGrant(
            { ...thirdScope, namespaceWriterEpoch: 4 },
            "restart-lower-authority",
            targetId,
          ),
        }),
      ).rejects.toThrow(/lower_writer/u);

      appendFileSync(join(root, "synthetic-runtime.wal"), "{corrupt}\n");
      expect(() => createSyntheticRuntimeStorage(root)).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("routes valid mutations through distinct runtime, provider, and session final ports", async () => {
    const { dispatcher, storage } = await readyRuntime();
    for (const boundary of ["runtime", "provider", "session"] as const) {
      const receipt = await dispatcher.dispatch({
        boundary,
        kind: "start",
        ticket: createTicketPreparer().prepare(
          targetTicket(fence(), `boundary-${boundary}`),
        ),
      });
      expect(receipt.state).toBe("accepted");
    }
    expect(storage.boundaryMutationCalls).toEqual({
      provider: 1,
      runtime: 1,
      session: 1,
    });
    expect(storage.finalMutationCalls).toBe(3);
  });

  it("rejects every lower, missing, and equal-version mismatch at runtime, provider, and session mutators after restart", async () => {
    const { broker, dispatcher, preparedTicket, storage } =
      await readyRuntime();
    let captured: RuntimeMutationRequestV1 | undefined;
    broker.beforeFinalMutation = (request) => {
      captured = request;
      return Promise.resolve();
    };
    await dispatcher.dispatch({
      boundary: "runtime",
      kind: "start",
      ticket: preparedTicket,
    });
    expect(captured).toBeDefined();
    const original = captured as unknown as RuntimeMutationRequestV1;
    const callsBefore = storage.finalMutationCalls;

    const restarted = new SyntheticRuntimeBroker(storage);
    restarted.recover(fence());
    const restartedDispatcher = new DurableRuntimeDispatcher({
      client: restarted,
      store: new InMemoryRuntimeOperationStore(),
    });
    await install(restartedDispatcher, fence(), "restart-authority");

    const variants: readonly [string, MutationFence][] = [
      [
        "lower-cluster",
        fence({
          clusterIncarnationVersion: 2,
          clusterIncarnation: "cluster-two",
        }),
      ],
      ["lower-writer", fence({ namespaceWriterEpoch: 4 })],
      ["lower-owner", fence({ ownerFence: 10 })],
      ["lower-gate", fence({ operationGateRevision: 6 })],
      ["lower-revocation", fence({ issuedStartRevocationRevision: 16 })],
      ["lower-desired", fence({ expectedDesiredVersion: 12 })],
      ["lower-node", fence({ nodeBootEpoch: 18 })],
      ["missing-owner", fenceWithoutAllocation()],
      ["missing-node", fenceWithoutNode()],
      [
        "equal-cluster-mismatch",
        fence({ clusterIncarnation: "cluster-other" }),
      ],
      [
        "equal-gate-mismatch",
        fence({ requiredGate: "alternate-process-start" }),
      ],
      [
        "equal-generation-mismatch",
        fence({ executionGeneration: "generation-other" }),
      ],
      [
        "equal-allocation-mismatch",
        fence({ allocationId: "allocation-other" }),
      ],
      ["equal-start-mismatch", fence({ startFence: "start-fence-other" })],
      [
        "equal-supersession-mismatch",
        fence({ supersessionKey: "runtime-start-other" }),
      ],
      ["equal-node-mismatch", fence({ nodeId: "node-other" })],
    ];
    for (const boundary of ["runtime", "provider", "session"] as const) {
      for (const [name, staleFence] of variants) {
        await expect(
          mutateAtBoundary(
            restarted,
            requestWithFence(original, staleFence, name, boundary),
          ),
        ).rejects.toThrow();
      }
      const missing = {
        ...original,
        boundary,
        idempotencyKey: `missing-fence-${boundary}`,
        intentFingerprint: `missing-fence-${boundary}`,
        mutationFence: undefined,
        operationId: `missing-fence-${boundary}`,
      } as unknown as RuntimeMutationRequestV1;
      await expect(mutateAtBoundary(restarted, missing)).rejects.toThrow();
      for (const field of [
        "schemaVersion",
        "clusterIncarnationVersion",
        "clusterIncarnation",
        "namespaceId",
        "namespaceWriterEpoch",
        "operationGateRevision",
        "requiredGate",
        "attemptId",
        "executionGeneration",
        "allocationId",
        "ownerFence",
        "desiredEffect",
        "expectedDesiredVersion",
        "supersessionKey",
        "effectScopeKey",
        "startFence",
        "issuedStartRevocationRevision",
        "nodeId",
        "nodeBootEpoch",
      ] as const) {
        const incompleteFence = {
          ...fence(),
        } as unknown as Record<string, unknown>;
        Reflect.deleteProperty(incompleteFence, field);
        const incomplete = {
          ...original,
          boundary,
          idempotencyKey: `missing-${field}-${boundary}`,
          intentFingerprint: `missing-${field}-${boundary}`,
          mutationFence: incompleteFence,
          operationId: `missing-${field}-${boundary}`,
          ticket: {
            ...original.ticket,
            mutationFence: incompleteFence,
            operationId: `missing-${field}-${boundary}`,
          },
        } as unknown as RuntimeMutationRequestV1;
        await expect(mutateAtBoundary(restarted, incomplete)).rejects.toThrow();
      }
    }
    expect(storage.finalMutationCalls).toBe(callsBefore);
  });

  it("revalidates after a provider wait and makes stale queued work lose to takeover", async () => {
    const { broker, dispatcher, preparedTicket, storage } =
      await readyRuntime();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    broker.beforeFinalMutation = async () => {
      entered?.();
      await held;
    };
    const pending = dispatcher.dispatch({
      boundary: "provider",
      kind: "start",
      ticket: preparedTicket,
    });
    await waiting;
    const takeoverFence = fence({ ownerFence: 12 });
    await install(dispatcher, takeoverFence, "owner-takeover");
    release?.();
    await expect(pending).resolves.toMatchObject({ state: "unknown" });
    expect(storage.finalMutationCalls).toBe(0);
  });

  it.each([
    ["owner takeover", { ownerFence: 12 }, true],
    ["writer cutover", { namespaceWriterEpoch: 6 }, true],
    ["gate closure", { operationGateRevision: 8 }, false],
    ["start revocation", { issuedStartRevocationRevision: 18 }, false],
  ] as const)(
    "orders %s as close, advance/install, acknowledge, then optional reopen",
    async (_name, override, reopen) => {
      const { broker, dispatcher, preparedTicket, storage } =
        await readyRuntime();
      let original: RuntimeMutationRequestV1 | undefined;
      broker.beforeFinalMutation = (request) => {
        original = request;
        return Promise.reject(new Error("capture-before-mutation"));
      };
      await dispatcher.dispatch({
        boundary: "runtime",
        kind: "start",
        ticket: preparedTicket,
      });
      broker.beforeFinalMutation = undefined;
      expect(original).toBeDefined();
      const next = fence(override);
      await install(
        dispatcher,
        next,
        `change-${String(next.ownerFence)}`,
        reopen,
      );
      for (const boundary of ["runtime", "provider", "session"] as const) {
        await expect(
          mutateAtBoundary(
            broker,
            requestWithFence(
              original as unknown as RuntimeMutationRequestV1,
              fence(),
              `old-${boundary}`,
              boundary,
            ),
          ),
        ).rejects.toThrow();
      }
      expect(storage.finalMutationCalls).toBe(0);
      if (reopen) {
        const nextTicket = createTicketPreparer().prepare(
          targetTicket(next, "next-authority"),
        );
        const receipt = await dispatcher.dispatch({
          boundary: "runtime",
          kind: "start",
          ticket: nextTicket,
        });
        expect(receipt.state).toBe("accepted");
        expect(storage.finalMutationCalls).toBe(1);
      }
    },
  );

  it("requires the exact complete tuple fingerprint even when all monotonic versions are equal", async () => {
    const { broker, dispatcher, preparedTicket, storage } =
      await readyRuntime();
    let request: RuntimeMutationRequestV1 | undefined;
    broker.beforeFinalMutation = (candidate) => {
      request = candidate;
      return Promise.reject(new Error("capture"));
    };
    await dispatcher.dispatch({
      boundary: "runtime",
      kind: "start",
      ticket: preparedTicket,
    });
    broker.beforeFinalMutation = undefined;
    const mismatched = {
      ...(request as unknown as RuntimeMutationRequestV1),
      boundary: "session" as const,
      idempotencyKey: "tuple-fingerprint-mismatch",
      intentFingerprint: "tuple-fingerprint-mismatch",
      mutationFenceFingerprint: `fence-v1-${"0".repeat(64)}`,
      operationId: "tuple-fingerprint-mismatch",
    };
    await expect(mutateAtBoundary(broker, mismatched)).rejects.toThrow();
    expect(storage.finalMutationCalls).toBe(0);
  });
});

it("publishes the exact broker contract version", () => {
  expect(RUNTIME_BROKER_CONTRACT_VERSION).toBe(
    "subscription-runtime.broker.v1",
  );
});
