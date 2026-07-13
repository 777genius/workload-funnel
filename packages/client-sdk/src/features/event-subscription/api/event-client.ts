import type {
  PublicConsumerLimits,
  PublicConsumerRegistration,
  PublicEventV1,
  PublicSnapshotV1,
  PublicStreamClass,
} from "@workload-funnel/workload-control/control-event-delivery";

export interface EventTransport {
  request<T>(
    input: Readonly<{
      method: "GET" | "POST";
      path: string;
      query?: Readonly<Record<string, string>>;
      body?: unknown;
    }>,
  ): Promise<T>;
}

export interface SnapshotResponseV1<T> extends PublicSnapshotV1<T> {
  readonly cursor: string;
}

export interface EventPageResponseV1 {
  readonly contractVersion: "workload-funnel.event-page/v1";
  readonly events: readonly PublicEventV1[];
  readonly cursor: string;
  readonly snapshotWatermark: number;
  readonly headPosition: number;
  readonly hasMore: boolean;
}

export interface ConsumerEventPageV1 {
  readonly events: readonly PublicEventV1[];
  readonly after: Readonly<{ streamPosition: number; eventId: string }>;
  readonly snapshotWatermark: number;
  readonly headPosition: number;
  readonly hasMore: boolean;
}

export interface EventSubscriptionOptions {
  readonly partition?: string;
  readonly streamClass?: PublicStreamClass;
  readonly limit?: number;
}

export interface ConsumerMutationOptions {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly requestId?: string;
  readonly expectedVersion?: number;
}

export function createEventSubscriptionClient<TSnapshot>(
  transport: EventTransport,
  tenantId: string,
): Readonly<{
  snapshot(
    options?: EventSubscriptionOptions,
  ): Promise<SnapshotResponseV1<TSnapshot>>;
  events(
    cursor: string,
    snapshotWatermark: number,
    options?: EventSubscriptionOptions,
  ): Promise<EventPageResponseV1>;
  registerConsumer(
    input: Readonly<{
      consumerId: string;
      cursor: string;
      snapshotWatermark: number;
      limits: PublicConsumerLimits;
      options?: EventSubscriptionOptions;
    }>,
    mutation: ConsumerMutationOptions,
  ): Promise<PublicConsumerRegistration>;
  consume(consumerId: string): Promise<
    Readonly<{
      registration: PublicConsumerRegistration;
      page: ConsumerEventPageV1;
    }>
  >;
  acknowledge(
    consumerId: string,
    through: Readonly<{ streamPosition: number; eventId: string }>,
    mutation: ConsumerMutationOptions,
  ): Promise<PublicConsumerRegistration>;
}> {
  function baseQuery(
    options: EventSubscriptionOptions = {},
  ): Record<string, string> {
    return {
      partition: options.partition ?? "control-1",
      streamClass: options.streamClass ?? "general",
      tenant: tenantId,
    };
  }
  return Object.freeze({
    acknowledge: (consumerId, through, mutation) =>
      transport.request({
        body: Object.freeze({
          mutation: Object.freeze({
            causationId: mutation.correlationId,
            contractVersion: "workload-funnel.mutation/v1",
            correlationId: mutation.correlationId,
            expectedVersion: mutation.expectedVersion,
            idempotencyKey: mutation.idempotencyKey,
            requestedTenantScope: tenantId,
            requestId: mutation.requestId ?? crypto.randomUUID(),
          }),
          through,
        }),
        method: "POST",
        path: `/v1/event-consumers/${encodeURIComponent(consumerId)}/acknowledgements`,
      }),
    consume: (consumerId) =>
      transport.request({
        method: "GET",
        path: `/v1/event-consumers/${encodeURIComponent(consumerId)}`,
        query: Object.freeze({ tenant: tenantId }),
      }),
    events(cursor, snapshotWatermark, options = {}) {
      return transport.request({
        method: "GET",
        path: "/v1/events",
        query: Object.freeze({
          ...baseQuery(options),
          cursor,
          limit: String(options.limit ?? 100),
          snapshotWatermark: String(snapshotWatermark),
        }),
      });
    },
    registerConsumer(input, mutation) {
      const options = input.options ?? {};
      return transport.request({
        body: Object.freeze({
          consumerId: input.consumerId,
          cursor: input.cursor,
          limits: input.limits,
          mutation: Object.freeze({
            causationId: mutation.correlationId,
            contractVersion: "workload-funnel.mutation/v1",
            correlationId: mutation.correlationId,
            expectedVersion: mutation.expectedVersion,
            idempotencyKey: mutation.idempotencyKey,
            requestedTenantScope: tenantId,
            requestId: mutation.requestId ?? crypto.randomUUID(),
          }),
          partition: options.partition ?? "control-1",
          snapshotWatermark: input.snapshotWatermark,
          streamClass: options.streamClass ?? "general",
        }),
        method: "POST",
        path: "/v1/event-consumers",
      });
    },
    snapshot(options = {}) {
      return transport.request({
        method: "GET",
        path: "/v1/snapshots/workloads",
        query: Object.freeze(baseQuery(options)),
      });
    },
  });
}
