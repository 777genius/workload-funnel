import { describe, expect, it } from "vitest";

import {
  applyProjectionEvent,
  assignVisibleStreamPosition,
  claimConsumer,
  consumeDurableBatch,
  createInMemoryDurableStreamStore,
  type ConsumerRegistration,
  type DurableEvent,
  type ProjectionCheckpoint,
} from "../index.js";

function event(id: string, committed = true): DurableEvent {
  return Object.freeze({
    aggregateId: "attempt-1",
    aggregateVersion: Number(id.slice(-1)),
    committed,
    eventId: id,
    eventOrdinal: 0,
    kind: "AttemptChanged",
    payloadDigest: `digest-${id}`,
  });
}

function consumer(): ConsumerRegistration {
  return Object.freeze({
    batchSize: 10,
    consumerId: "projection-1",
    cursor: 0,
    leaseFence: 1,
    leaseOwnerId: "worker-1",
    leaseUntil: 0,
    maximumLag: 100,
    partition: "control-1",
    replayHorizon: 1000,
    state: "active",
    version: 1,
  });
}

describe("Phase 2 durable event consumption", () => {
  it("assigns stream positions only after commit and without cursor holes", () => {
    expect(() =>
      assignVisibleStreamPosition(event("event-1", false), 1),
    ).toThrow("uncommitted_event_not_visible");
    const stream = createInMemoryDurableStreamStore();
    stream.append(event("event-1", false));
    stream.append(event("event-2"));
    expect(
      stream.publishCommitted().map((item) => item.streamPosition),
    ).toEqual([1]);
    expect(stream.after(0, 10).map((item) => item.eventId)).toEqual([
      "event-2",
    ]);
  });

  it("takes over an expired consumer with fence + 1 and rejects stale owners", () => {
    const takeover = claimConsumer(consumer(), "worker-2", 1, 20, 1);
    expect(takeover).toMatchObject({ leaseFence: 2, leaseOwnerId: "worker-2" });
    expect(() => claimConsumer(takeover, "worker-1", 2, 30, 2)).toThrow(
      "consumer_lease_held",
    );
  });

  it("moves poison messages to DLQ after bounded retries without hiding the position", () => {
    const stream = createInMemoryDurableStreamStore();
    stream.append(event("event-1"));
    stream.publishCommitted();
    const result = consumeDurableBatch(
      consumer(),
      "worker-1",
      1,
      20,
      stream,
      () => {
        throw new Error("poison");
      },
      3,
    );
    expect(result.deadLetters).toEqual([
      {
        attempts: 3,
        consumerId: "projection-1",
        eventId: "event-1",
        reasonCode: "handler_failed",
        state: "dead_letter",
        streamPosition: 1,
      },
    ]);
    expect(result.registration.cursor).toBe(1);
  });

  it("applies projection row and checkpoint atomically with dedup and gap rejection", () => {
    const checkpoint: ProjectionCheckpoint = Object.freeze({
      appliedEventIds: new Set<string>(),
      partition: "control-1",
      projectionName: "run-status",
      projectionVersion: 1,
      state: "active",
      streamPosition: 0,
      version: 1,
    });
    const visible = assignVisibleStreamPosition(event("event-1"), 1);
    const applied = applyProjectionEvent(checkpoint, visible);
    expect(applied).toMatchObject({ streamPosition: 1, version: 2 });
    expect(applyProjectionEvent(applied, visible)).toBe(applied);
    expect(() =>
      applyProjectionEvent(
        applied,
        assignVisibleStreamPosition(event("event-3"), 3),
      ),
    ).toThrow("projection_gap");
  });
});
