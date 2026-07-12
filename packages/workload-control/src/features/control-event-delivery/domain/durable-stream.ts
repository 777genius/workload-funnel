export interface DurableEvent {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventOrdinal: number;
  readonly kind: string;
  readonly payloadDigest: string;
  readonly committed: boolean;
  readonly streamPosition?: number;
}

export interface ConsumerRegistration {
  readonly consumerId: string;
  readonly partition: string;
  readonly leaseOwnerId: string;
  readonly leaseFence: number;
  readonly leaseUntil: number;
  readonly cursor: number;
  readonly maximumLag: number;
  readonly replayHorizon: number;
  readonly batchSize: number;
  readonly state: "active" | "expired" | "bootstrap_required";
  readonly version: number;
}

export interface DeadLetterRecord {
  readonly consumerId: string;
  readonly eventId: string;
  readonly streamPosition: number;
  readonly attempts: number;
  readonly reasonCode: string;
  readonly state: "dead_letter" | "reconciliation_required";
}

export interface ProjectionCheckpoint {
  readonly projectionName: string;
  readonly projectionVersion: number;
  readonly partition: string;
  readonly streamPosition: number;
  readonly appliedEventIds: ReadonlySet<string>;
  readonly state: "active" | "shadow" | "retired";
  readonly version: number;
}

export function assignVisibleStreamPosition(
  event: DurableEvent,
  nextPosition: number,
): DurableEvent {
  if (!event.committed) throw new Error("uncommitted_event_not_visible");
  if (event.streamPosition !== undefined) return event;
  return Object.freeze({ ...event, streamPosition: nextPosition });
}

export function claimConsumer(
  consumer: ConsumerRegistration,
  ownerId: string,
  now: number,
  leaseUntil: number,
  expectedFence: number,
): ConsumerRegistration {
  if (consumer.leaseFence !== expectedFence || leaseUntil <= now) {
    throw new Error("stale_consumer_lease");
  }
  if (consumer.state === "bootstrap_required") {
    throw new Error("consumer_bootstrap_required");
  }
  const takeover =
    consumer.leaseUntil <= now && consumer.leaseOwnerId !== ownerId;
  if (consumer.leaseUntil > now && consumer.leaseOwnerId !== ownerId) {
    throw new Error("consumer_lease_held");
  }
  return Object.freeze({
    ...consumer,
    leaseFence: takeover ? consumer.leaseFence + 1 : consumer.leaseFence,
    leaseOwnerId: ownerId,
    leaseUntil,
    state: "active",
    version: consumer.version + 1,
  });
}

export function advanceConsumerCursor(
  consumer: ConsumerRegistration,
  ownerId: string,
  leaseFence: number,
  streamPosition: number,
): ConsumerRegistration {
  if (
    consumer.leaseOwnerId !== ownerId ||
    consumer.leaseFence !== leaseFence ||
    consumer.state !== "active"
  )
    throw new Error("stale_consumer_lease");
  if (streamPosition < consumer.cursor)
    throw new Error("consumer_cursor_regression");
  return Object.freeze({
    ...consumer,
    cursor: streamPosition,
    version: consumer.version + 1,
  });
}

export function applyProjectionEvent(
  checkpoint: ProjectionCheckpoint,
  event: DurableEvent,
): ProjectionCheckpoint {
  if (event.streamPosition === undefined) throw new Error("event_not_visible");
  if (checkpoint.appliedEventIds.has(event.eventId)) return checkpoint;
  if (event.streamPosition !== checkpoint.streamPosition + 1) {
    throw new Error("projection_gap");
  }
  return Object.freeze({
    ...checkpoint,
    appliedEventIds: new Set([...checkpoint.appliedEventIds, event.eventId]),
    streamPosition: event.streamPosition,
    version: checkpoint.version + 1,
  });
}
