export interface OutboxMessage {
  readonly messageId: string;
  readonly kind: "attempt-ready" | "attempt-canceled" | "attachment-rejected";
  readonly aggregateId: string;
  readonly delivered: boolean;
  readonly sequence: number;
}

export interface InboxReceipt {
  readonly consumer: string;
  readonly messageId: string;
  readonly completed: boolean;
}

export interface StatusProjection {
  readonly runId: string;
  readonly state: string;
  readonly watermark: number;
}

export interface DeliveryStore {
  append(
    kind: OutboxMessage["kind"],
    aggregateId: string,
    stableKey: string,
  ): OutboxMessage;
  pending(): readonly OutboxMessage[];
  complete(consumer: string, messageId: string): InboxReceipt;
  wasCompleted(consumer: string, messageId: string): boolean;
  project(projection: StatusProjection): void;
  projection(runId: string): StatusProjection | undefined;
}

export interface OutboxStore {
  append(
    kind: OutboxMessage["kind"],
    aggregateId: string,
    stableKey: string,
  ): OutboxMessage;
  pending(): readonly OutboxMessage[];
  markDelivered(messageId: string): OutboxMessage;
  redeliver(messageId: string): OutboxMessage;
}

export interface InboxStore {
  complete(consumer: string, messageId: string): InboxReceipt;
  get(consumer: string, messageId: string): InboxReceipt | undefined;
}

export interface ProjectionCheckpointStore {
  project(projection: StatusProjection): void;
  get(runId: string): StatusProjection | undefined;
}
