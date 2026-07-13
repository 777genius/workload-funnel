import { describe, expect, it } from "vitest";

import {
  createInMemoryPublicEventFeed,
  PublicCursorExpiredError,
  SlowConsumerBootstrapRequiredError,
  type PublicConsumerLimits,
} from "../index.js";

const limits: PublicConsumerLimits = Object.freeze({
  batchSize: 1,
  leaseDurationMs: 100,
  maximumBufferedBytes: 100_000,
  maximumBufferedCount: 2,
  maximumLag: 2,
  replayHorizonMs: 1000,
});

function append(
  feed: ReturnType<typeof createInMemoryPublicEventFeed>,
  eventId: string,
  occurredAt: number,
) {
  return feed.append({
    aggregateId: "run-1",
    aggregateVersion: Number(eventId.slice(-1)),
    causationId: eventId,
    correlationId: "correlation-1",
    eventId,
    eventOrdinal: 0,
    eventType: "RunObserved",
    occurredAt,
    partition: "control-1",
    payload: Object.freeze({ state: "running" }),
    streamClass: "observation",
    tenantId: "tenant-1",
  });
}

describe("Phase 5 public snapshots and bounded slow-consumer lifecycle", () => {
  it("takes a fixed-watermark snapshot and pages with a bounded keyset", () => {
    const feed = createInMemoryPublicEventFeed();
    append(feed, "event-1", 1);
    const source = [{ runId: "run-1" }];
    const snapshot = feed.snapshot({
      generatedAt: 2,
      partition: "control-1",
      readItems: () => [...source],
      tenantId: "tenant-1",
    });
    const firstSource = source[0];
    if (firstSource === undefined) throw new Error("snapshot_source_missing");
    firstSource.runId = "caller-mutated";
    source.push({ runId: "run-2" });
    append(feed, "event-2", 3);
    expect(snapshot.snapshotWatermark).toBe(1);
    expect(snapshot.items).toEqual([{ runId: "run-1" }]);
    const page = feed.page({
      after: Object.freeze({ eventId: "", streamPosition: 1 }),
      limit: 1,
      partition: "control-1",
      snapshotWatermark: snapshot.snapshotWatermark,
      tenantId: "tenant-1",
    });
    expect(page.events.map((event) => event.eventId)).toEqual(["event-2"]);
    expect(page.after).toEqual({ eventId: "event-2", streamPosition: 2 });
  });

  it("detaches and deeply freezes event payloads", () => {
    const feed = createInMemoryPublicEventFeed();
    const payload = { nested: { state: "running" } };
    const appended = feed.append({
      aggregateId: "run-1",
      aggregateVersion: 1,
      causationId: "event-payload",
      correlationId: "correlation-1",
      eventId: "event-payload",
      eventOrdinal: 0,
      eventType: "RunObserved",
      occurredAt: 1,
      partition: "control-1",
      payload,
      streamClass: "observation",
      tenantId: "tenant-1",
    });
    payload.nested.state = "caller-mutated";
    expect(appended.payload).toEqual({ nested: { state: "running" } });
    expect(Object.isFrozen(appended.payload["nested"])).toBe(true);
  });

  it("expires lagging registrations without allowing them to block compaction", () => {
    const feed = createInMemoryPublicEventFeed();
    const registration = feed.registerConsumer({
      consumerId: "consumer-1",
      leaseOwnerId: "worker-1",
      limits,
      now: 10,
      partition: "control-1",
      start: Object.freeze({ eventId: "", streamPosition: 0 }),
      streamClass: "observation",
      tenantId: "tenant-1",
    });
    append(feed, "event-1", 11);
    append(feed, "event-2", 12);
    append(feed, "event-3", 13);
    try {
      feed.consume({
        consumerId: registration.consumerId,
        leaseFence: registration.leaseFence,
        leaseOwnerId: registration.leaseOwnerId,
        now: 14,
      });
      throw new Error("expected_slow_consumer_failure");
    } catch (error) {
      expect(error).toBeInstanceOf(SlowConsumerBootstrapRequiredError);
      expect(
        (error as SlowConsumerBootstrapRequiredError).registration,
      ).toMatchObject({
        bootstrapReason: "lag_exceeded",
        state: "bootstrap_required",
      });
    }
    feed.compactThrough("control-1", 2);
    expect(() =>
      feed.page({
        after: Object.freeze({ eventId: "", streamPosition: 0 }),
        limit: 1,
        partition: "control-1",
        snapshotWatermark: 0,
        tenantId: "tenant-1",
      }),
    ).toThrow(PublicCursorExpiredError);
  });

  it("does not compact past an active consumer and rejects conflicting registration reuse", () => {
    const feed = createInMemoryPublicEventFeed();
    const registration = feed.registerConsumer({
      consumerId: "consumer-blocking",
      leaseOwnerId: "worker-1",
      limits,
      now: 10,
      partition: "control-1",
      start: Object.freeze({ eventId: "", streamPosition: 0 }),
      streamClass: "observation",
      tenantId: "tenant-1",
    });
    append(feed, "event-1", 11);
    expect(() => {
      feed.compactThrough("control-1", 1);
    }).toThrow("active_consumer_blocks_compaction");
    expect(feed.expireConsumers(registration.leaseUntil)).toBe(1);
    expect(() => {
      feed.compactThrough("control-1", 1);
    }).not.toThrow();
    expect(() =>
      feed.registerConsumer({
        consumerId: registration.consumerId,
        leaseOwnerId: registration.leaseOwnerId,
        limits: Object.freeze({ ...limits, batchSize: 2 }),
        now: 12,
        partition: registration.partition,
        start: registration.cursor,
        streamClass: registration.streamClass,
        tenantId: registration.tenantId,
      }),
    ).toThrow("consumer_id_conflict");
  });

  it("enforces replay-horizon and byte budgets independently", () => {
    const feed = createInMemoryPublicEventFeed();
    append(feed, "event-1", 1);
    const registration = feed.registerConsumer({
      consumerId: "consumer-old",
      leaseOwnerId: "worker-1",
      limits: Object.freeze({ ...limits, maximumLag: 10 }),
      now: 1,
      partition: "control-1",
      start: Object.freeze({ eventId: "", streamPosition: 0 }),
      streamClass: "observation",
      tenantId: "tenant-1",
    });
    expect(() =>
      feed.consume({
        consumerId: registration.consumerId,
        leaseFence: registration.leaseFence,
        leaseOwnerId: registration.leaseOwnerId,
        now: 2000,
      }),
    ).toThrow(SlowConsumerBootstrapRequiredError);
  });

  it("redelivers an unacknowledged page and advances only through a fenced acknowledgement", () => {
    const feed = createInMemoryPublicEventFeed();
    const registration = feed.registerConsumer({
      consumerId: "consumer-ack",
      leaseOwnerId: "worker-1",
      limits,
      now: 10,
      partition: "control-1",
      start: Object.freeze({ eventId: "", streamPosition: 0 }),
      streamClass: "observation",
      tenantId: "tenant-1",
    });
    append(feed, "event-1", 11);
    const first = feed.consume({
      consumerId: registration.consumerId,
      leaseFence: registration.leaseFence,
      leaseOwnerId: registration.leaseOwnerId,
      now: 12,
    });
    const redelivered = feed.consume({
      consumerId: registration.consumerId,
      leaseFence: registration.leaseFence,
      leaseOwnerId: registration.leaseOwnerId,
      now: 13,
    });
    expect(redelivered.page.events).toEqual(first.page.events);
    const acknowledged = feed.acknowledgeConsumer({
      consumerId: registration.consumerId,
      leaseFence: registration.leaseFence,
      leaseOwnerId: registration.leaseOwnerId,
      now: 14,
      through: first.page.after,
    });
    expect(acknowledged.cursor).toEqual(first.page.after);
    expect(
      feed.consume({
        consumerId: registration.consumerId,
        leaseFence: registration.leaseFence,
        leaseOwnerId: registration.leaseOwnerId,
        now: 15,
      }).page.events,
    ).toEqual([]);
  });
});
