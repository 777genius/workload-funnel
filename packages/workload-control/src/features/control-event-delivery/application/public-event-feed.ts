export const PUBLIC_EVENT_CONTRACT_VERSION =
  "workload-funnel.event/v1" as const;
export const PUBLIC_SNAPSHOT_CONTRACT_VERSION =
  "workload-funnel.snapshot/v1" as const;

export type PublicStreamClass = "observation" | "cancellation" | "general";

export interface PublicEventV1 {
  readonly contractVersion: typeof PUBLIC_EVENT_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly partition: string;
  readonly streamClass: PublicStreamClass;
  readonly streamPosition: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly eventOrdinal: number;
  readonly eventType: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly occurredAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface PublicSnapshotV1<T> {
  readonly contractVersion: typeof PUBLIC_SNAPSHOT_CONTRACT_VERSION;
  readonly tenantId: string;
  readonly partition: string;
  readonly snapshotWatermark: number;
  readonly generatedAt: number;
  readonly items: readonly T[];
}

export interface EventKeyset {
  readonly streamPosition: number;
  readonly eventId: string;
}

export interface PublicEventPage {
  readonly events: readonly PublicEventV1[];
  readonly after: EventKeyset;
  readonly snapshotWatermark: number;
  readonly headPosition: number;
  readonly hasMore: boolean;
}

export interface PublicConsumerLimits {
  readonly maximumLag: number;
  readonly replayHorizonMs: number;
  readonly maximumBufferedCount: number;
  readonly maximumBufferedBytes: number;
  readonly batchSize: number;
  readonly leaseDurationMs: number;
}

export interface PublicConsumerRegistration {
  readonly consumerId: string;
  readonly tenantId: string;
  readonly partition: string;
  readonly streamClass: PublicStreamClass;
  readonly leaseOwnerId: string;
  readonly leaseFence: number;
  readonly leaseUntil: number;
  readonly cursor: EventKeyset;
  readonly snapshotWatermark: number;
  readonly limits: PublicConsumerLimits;
  readonly state: "active" | "expired" | "bootstrap_required";
  readonly bootstrapReason?:
    | "lease_expired"
    | "lag_exceeded"
    | "replay_horizon_exceeded"
    | "count_budget_exceeded"
    | "byte_budget_exceeded"
    | "history_compacted";
  readonly version: number;
}

export class PublicCursorExpiredError extends Error {
  public readonly code = "cursor_expired";

  public constructor(
    public readonly snapshotPath: string,
    public readonly oldestAvailablePosition: number,
  ) {
    super("cursor_expired");
    this.name = "PublicCursorExpiredError";
  }
}

export class SlowConsumerBootstrapRequiredError extends Error {
  public readonly code = "consumer_bootstrap_required";

  public constructor(
    public readonly registration: PublicConsumerRegistration,
    public readonly snapshotPath: string,
  ) {
    super("consumer_bootstrap_required");
    this.name = "SlowConsumerBootstrapRequiredError";
  }
}

export interface PublicEventFeed {
  append(
    event: Omit<PublicEventV1, "contractVersion" | "streamPosition">,
  ): PublicEventV1;
  compactThrough(partition: string, position: number): void;
  expireConsumers(now: number): number;
  head(partition: string): number;
  snapshot<T>(input: {
    readonly tenantId: string;
    readonly partition: string;
    readonly generatedAt: number;
    readonly readItems: (watermark: number) => readonly T[];
  }): PublicSnapshotV1<T>;
  page(input: {
    readonly tenantId: string;
    readonly partition: string;
    readonly streamClass?: PublicStreamClass;
    readonly after: EventKeyset;
    readonly snapshotWatermark: number;
    readonly limit: number;
  }): PublicEventPage;
  registerConsumer(input: {
    readonly consumerId: string;
    readonly tenantId: string;
    readonly partition: string;
    readonly streamClass: PublicStreamClass;
    readonly leaseOwnerId: string;
    readonly now: number;
    readonly start: EventKeyset;
    readonly snapshotWatermark?: number;
    readonly limits: PublicConsumerLimits;
  }): PublicConsumerRegistration;
  consume(input: {
    readonly consumerId: string;
    readonly leaseOwnerId: string;
    readonly leaseFence: number;
    readonly now: number;
  }): Readonly<{
    registration: PublicConsumerRegistration;
    page: PublicEventPage;
  }>;
  acknowledgeConsumer(input: {
    readonly consumerId: string;
    readonly leaseOwnerId: string;
    readonly leaseFence: number;
    readonly through: EventKeyset;
    readonly now: number;
  }): PublicConsumerRegistration;
}

function validNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function boundedIdentifier(value: string, maximum = 256): boolean {
  return value.length > 0 && value.length <= maximum && !/\p{Cc}/u.test(value);
}

function validateKeyset(keyset: EventKeyset): void {
  if (
    !validNonnegativeInteger(keyset.streamPosition) ||
    keyset.eventId.length > 256 ||
    /\p{Cc}/u.test(keyset.eventId)
  )
    throw new Error("invalid_event_keyset");
}

function immutableJsonObject(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const visited = new WeakSet<object>();
  let nodes = 0;
  function visit(value: unknown, depth: number): unknown {
    nodes += 1;
    if (nodes > 100_000 || depth > 64)
      throw new Error("invalid_public_event_payload");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value))
        throw new Error("invalid_public_event_payload");
      return value;
    }
    if (typeof value !== "object" || visited.has(value))
      throw new Error("invalid_public_event_payload");
    visited.add(value);
    if (Array.isArray(value))
      return Object.freeze(value.map((item) => visit(item, depth + 1)));
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error("invalid_public_event_payload");
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          visit(child, depth + 1),
        ]),
      ),
    );
  }
  return visit(input, 0) as Readonly<Record<string, unknown>>;
}

function validateLimits(limits: PublicConsumerLimits): void {
  if (
    !validNonnegativeInteger(limits.maximumLag) ||
    !validNonnegativeInteger(limits.replayHorizonMs) ||
    !validNonnegativeInteger(limits.maximumBufferedCount) ||
    !validNonnegativeInteger(limits.maximumBufferedBytes) ||
    limits.maximumLag > 100_000 ||
    limits.replayHorizonMs > 604_800_000 ||
    limits.maximumBufferedCount > 100_000 ||
    limits.maximumBufferedBytes > 67_108_864 ||
    !Number.isSafeInteger(limits.batchSize) ||
    limits.batchSize < 1 ||
    limits.batchSize > 500 ||
    !Number.isSafeInteger(limits.leaseDurationMs) ||
    limits.leaseDurationMs < 1 ||
    limits.leaseDurationMs > 300_000
  ) {
    throw new Error("invalid_consumer_limits");
  }
}

function byteSize(event: PublicEventV1): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function compareKeyset(event: PublicEventV1, after: EventKeyset): boolean {
  return (
    event.streamPosition > after.streamPosition ||
    (event.streamPosition === after.streamPosition &&
      after.eventId.length > 0 &&
      event.eventId > after.eventId)
  );
}

function bootstrap(
  registration: PublicConsumerRegistration,
  reason: NonNullable<PublicConsumerRegistration["bootstrapReason"]>,
): PublicConsumerRegistration {
  return Object.freeze({
    ...registration,
    bootstrapReason: reason,
    state: "bootstrap_required",
    version: registration.version + 1,
  });
}

export function createInMemoryPublicEventFeed(): PublicEventFeed {
  const events: PublicEventV1[] = [];
  const heads = new Map<string, number>();
  const consumers = new Map<string, PublicConsumerRegistration>();
  const deliveredThrough = new Map<string, EventKeyset>();
  const compactedThrough = new Map<string, number>();
  const compactedEventIds = new Set<string>();

  function matchingEvents(input: {
    readonly tenantId: string;
    readonly partition: string;
    readonly streamClass?: PublicStreamClass;
    readonly after: EventKeyset;
  }): readonly PublicEventV1[] {
    return events.filter(
      (event) =>
        event.tenantId === input.tenantId &&
        event.partition === input.partition &&
        (input.streamClass === undefined ||
          event.streamClass === input.streamClass) &&
        compareKeyset(event, input.after),
    );
  }

  function page(input: {
    readonly tenantId: string;
    readonly partition: string;
    readonly streamClass?: PublicStreamClass;
    readonly after: EventKeyset;
    readonly snapshotWatermark: number;
    readonly limit: number;
  }): PublicEventPage {
    validateKeyset(input.after);
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500
    )
      throw new Error("invalid_event_page_limit");
    if (
      !validNonnegativeInteger(input.snapshotWatermark) ||
      input.snapshotWatermark > input.after.streamPosition ||
      !boundedIdentifier(input.tenantId) ||
      !boundedIdentifier(input.partition)
    )
      throw new Error("invalid_event_page");
    const compactedPosition = compactedThrough.get(input.partition) ?? 0;
    if (input.after.streamPosition < compactedPosition) {
      throw new PublicCursorExpiredError(
        "/v1/snapshots/workloads",
        compactedPosition + 1,
      );
    }
    const matching = matchingEvents(input);
    const selected = matching.slice(0, input.limit);
    const last = selected.at(-1);
    return Object.freeze({
      after:
        last === undefined
          ? input.after
          : Object.freeze({
              eventId: last.eventId,
              streamPosition: last.streamPosition,
            }),
      events: Object.freeze(selected),
      hasMore: matching.length > selected.length,
      headPosition: heads.get(input.partition) ?? 0,
      snapshotWatermark: input.snapshotWatermark,
    });
  }

  const feed: PublicEventFeed = {
    acknowledgeConsumer(input) {
      validateKeyset(input.through);
      if (!validNonnegativeInteger(input.now))
        throw new Error("invalid_consumer_time");
      const existing = consumers.get(input.consumerId);
      if (existing === undefined) throw new Error("consumer_not_found");
      if (
        existing.leaseOwnerId !== input.leaseOwnerId ||
        existing.leaseFence !== input.leaseFence ||
        existing.leaseUntil <= input.now
      )
        throw new Error("stale_consumer_lease");
      if (existing.state !== "active")
        throw new SlowConsumerBootstrapRequiredError(
          existing,
          "/v1/snapshots/workloads",
        );
      if (
        input.through.streamPosition < existing.cursor.streamPosition ||
        (input.through.streamPosition === existing.cursor.streamPosition &&
          input.through.eventId < existing.cursor.eventId)
      )
        throw new Error("consumer_cursor_regression");
      if (
        input.through.streamPosition === existing.cursor.streamPosition &&
        input.through.eventId === existing.cursor.eventId
      )
        return existing;
      const offered = deliveredThrough.get(existing.consumerId);
      if (
        offered === undefined ||
        input.through.streamPosition > offered.streamPosition ||
        (input.through.streamPosition === offered.streamPosition &&
          input.through.eventId > offered.eventId)
      )
        throw new Error("consumer_acknowledgement_not_delivered");
      const acknowledgedEvent = events.find(
        (event) =>
          event.tenantId === existing.tenantId &&
          event.partition === existing.partition &&
          event.streamClass === existing.streamClass &&
          event.streamPosition === input.through.streamPosition &&
          event.eventId === input.through.eventId,
      );
      if (acknowledgedEvent === undefined)
        throw new Error("consumer_acknowledgement_not_delivered");
      const next = Object.freeze({
        ...existing,
        cursor: Object.freeze({ ...input.through }),
        version: existing.version + 1,
      });
      consumers.set(existing.consumerId, next);
      if (
        offered.streamPosition === input.through.streamPosition &&
        offered.eventId === input.through.eventId
      )
        deliveredThrough.delete(existing.consumerId);
      return next;
    },
    append(input) {
      const candidatePayload: unknown = input.payload;
      const identifiers = [
        input.tenantId,
        input.partition,
        input.eventId,
        input.aggregateId,
        input.eventType,
        input.correlationId,
        input.causationId,
      ];
      if (
        identifiers.some((value) => !boundedIdentifier(value)) ||
        !Number.isSafeInteger(input.aggregateVersion) ||
        input.aggregateVersion < 1 ||
        !validNonnegativeInteger(input.eventOrdinal) ||
        !validNonnegativeInteger(input.occurredAt) ||
        typeof candidatePayload !== "object" ||
        candidatePayload === null ||
        Array.isArray(candidatePayload)
      )
        throw new Error("invalid_public_event");
      const payload = immutableJsonObject(
        candidatePayload as Readonly<Record<string, unknown>>,
      );
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 1_048_576)
        throw new Error("invalid_public_event");
      if (compactedEventIds.has(`${input.partition}:${input.eventId}`))
        throw new Error("public_event_already_compacted");
      const duplicate = events.find(
        (event) =>
          event.partition === input.partition &&
          event.eventId === input.eventId,
      );
      if (duplicate !== undefined) {
        const expected = {
          ...input,
          contractVersion: PUBLIC_EVENT_CONTRACT_VERSION,
          payload,
          streamPosition: duplicate.streamPosition,
        };
        if (JSON.stringify(duplicate) !== JSON.stringify(expected))
          throw new Error("public_event_id_conflict");
        return duplicate;
      }
      const streamPosition = (heads.get(input.partition) ?? 0) + 1;
      heads.set(input.partition, streamPosition);
      const event = Object.freeze({
        ...input,
        contractVersion: PUBLIC_EVENT_CONTRACT_VERSION,
        payload,
        streamPosition,
      });
      events.push(event);
      return event;
    },
    compactThrough(partition, position) {
      const currentCompaction = compactedThrough.get(partition) ?? 0;
      if (
        !validNonnegativeInteger(position) ||
        position < currentCompaction ||
        position > (heads.get(partition) ?? 0)
      )
        throw new Error("invalid_compaction_position");
      if (
        [...consumers.values()].some(
          (registration) =>
            registration.partition === partition &&
            registration.state === "active" &&
            registration.cursor.streamPosition < position,
        )
      )
        throw new Error("active_consumer_blocks_compaction");
      compactedThrough.set(partition, position);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
          event?.partition === partition &&
          event.streamPosition <= position
        ) {
          compactedEventIds.add(`${partition}:${event.eventId}`);
          events.splice(index, 1);
        }
      }
    },
    consume(input) {
      if (
        !validNonnegativeInteger(input.now) ||
        input.now > Number.MAX_SAFE_INTEGER - 300_000
      )
        throw new Error("invalid_consumer_time");
      const existing = consumers.get(input.consumerId);
      if (existing === undefined) throw new Error("consumer_not_found");
      if (
        existing.leaseOwnerId !== input.leaseOwnerId ||
        existing.leaseFence !== input.leaseFence
      )
        throw new Error("stale_consumer_lease");
      if (existing.state !== "active") {
        throw new SlowConsumerBootstrapRequiredError(
          existing,
          "/v1/snapshots/workloads",
        );
      }
      let current = existing;
      if (existing.leaseUntil <= input.now) {
        current = bootstrap(existing, "lease_expired");
      } else {
        const pending = matchingEvents({
          after: existing.cursor,
          partition: existing.partition,
          streamClass: existing.streamClass,
          tenantId: existing.tenantId,
        });
        const pendingBytes = pending.reduce(
          (total, event) => total + byteSize(event),
          0,
        );
        const oldest = pending.at(0);
        if (pending.length > existing.limits.maximumLag) {
          current = bootstrap(existing, "lag_exceeded");
        } else if (pending.length > existing.limits.maximumBufferedCount) {
          current = bootstrap(existing, "count_budget_exceeded");
        } else if (pendingBytes > existing.limits.maximumBufferedBytes) {
          current = bootstrap(existing, "byte_budget_exceeded");
        } else if (
          oldest !== undefined &&
          input.now - oldest.occurredAt > existing.limits.replayHorizonMs
        ) {
          current = bootstrap(existing, "replay_horizon_exceeded");
        }
      }
      if (current.state !== "active") {
        consumers.set(input.consumerId, current);
        deliveredThrough.delete(input.consumerId);
        throw new SlowConsumerBootstrapRequiredError(
          current,
          "/v1/snapshots/workloads",
        );
      }
      const result = page({
        after: current.cursor,
        limit: current.limits.batchSize,
        partition: current.partition,
        snapshotWatermark: current.snapshotWatermark,
        streamClass: current.streamClass,
        tenantId: current.tenantId,
      });
      current = Object.freeze({
        ...current,
        leaseUntil: input.now + current.limits.leaseDurationMs,
        version: current.version + 1,
      });
      consumers.set(input.consumerId, current);
      if (result.events.length > 0)
        deliveredThrough.set(input.consumerId, result.after);
      return Object.freeze({ page: result, registration: current });
    },
    expireConsumers(now) {
      if (!validNonnegativeInteger(now)) throw new Error("invalid_expiry_time");
      let expired = 0;
      for (const [consumerId, registration] of consumers) {
        if (registration.state !== "active" || registration.leaseUntil > now)
          continue;
        consumers.set(consumerId, bootstrap(registration, "lease_expired"));
        deliveredThrough.delete(consumerId);
        expired += 1;
      }
      return expired;
    },
    head: (partition) => heads.get(partition) ?? 0,
    page,
    registerConsumer(input) {
      validateLimits(input.limits);
      validateKeyset(input.start);
      const snapshotWatermark =
        input.snapshotWatermark ?? input.start.streamPosition;
      if (
        !boundedIdentifier(input.consumerId, 128) ||
        !boundedIdentifier(input.tenantId) ||
        !boundedIdentifier(input.partition) ||
        !boundedIdentifier(input.leaseOwnerId) ||
        !validNonnegativeInteger(input.now) ||
        input.now > Number.MAX_SAFE_INTEGER - input.limits.leaseDurationMs ||
        !validNonnegativeInteger(snapshotWatermark) ||
        snapshotWatermark > input.start.streamPosition
      )
        throw new Error("invalid_consumer_registration");
      const prior = consumers.get(input.consumerId);
      if (prior !== undefined) {
        if (
          prior.tenantId !== input.tenantId ||
          prior.partition !== input.partition ||
          prior.streamClass !== input.streamClass ||
          prior.leaseOwnerId !== input.leaseOwnerId ||
          prior.snapshotWatermark !== snapshotWatermark ||
          prior.cursor.streamPosition !== input.start.streamPosition ||
          prior.cursor.eventId !== input.start.eventId ||
          JSON.stringify(prior.limits) !== JSON.stringify(input.limits)
        )
          throw new Error("consumer_id_conflict");
        return prior;
      }
      const compactedPosition = compactedThrough.get(input.partition) ?? 0;
      if (input.start.streamPosition < compactedPosition) {
        throw new PublicCursorExpiredError(
          "/v1/snapshots/workloads",
          compactedPosition + 1,
        );
      }
      const registration = Object.freeze({
        consumerId: input.consumerId,
        cursor: Object.freeze({ ...input.start }),
        leaseFence: 1,
        leaseOwnerId: input.leaseOwnerId,
        leaseUntil: input.now + input.limits.leaseDurationMs,
        limits: Object.freeze({ ...input.limits }),
        partition: input.partition,
        snapshotWatermark,
        state: "active" as const,
        streamClass: input.streamClass,
        tenantId: input.tenantId,
        version: 1,
      });
      consumers.set(input.consumerId, registration);
      return registration;
    },
    snapshot<T>(input: {
      readonly tenantId: string;
      readonly partition: string;
      readonly generatedAt: number;
      readonly readItems: (watermark: number) => readonly T[];
    }) {
      if (
        !boundedIdentifier(input.tenantId) ||
        !boundedIdentifier(input.partition) ||
        !validNonnegativeInteger(input.generatedAt)
      )
        throw new Error("invalid_public_snapshot");
      const watermark = heads.get(input.partition) ?? 0;
      const items = input.readItems(watermark).map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item))
          throw new Error("invalid_public_snapshot_item");
        return immutableJsonObject(
          item as Readonly<Record<string, unknown>>,
        ) as unknown as T;
      });
      return Object.freeze({
        contractVersion: PUBLIC_SNAPSHOT_CONTRACT_VERSION,
        generatedAt: input.generatedAt,
        items: Object.freeze(items),
        partition: input.partition,
        snapshotWatermark: watermark,
        tenantId: input.tenantId,
      });
    },
  };
  return Object.freeze(feed);
}
