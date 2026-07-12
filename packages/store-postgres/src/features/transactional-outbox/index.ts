import type {
  OutboxMessage,
  OutboxStore,
} from "@workload-funnel/workload-control/control-event-delivery";

export function createPostgresOutboxStore(
  messages: Map<string, OutboxMessage>,
  faults?: Readonly<{ hit(boundary: string): void }>,
): OutboxStore {
  const store: OutboxStore = {
    append(kind, aggregateId, stableKey) {
      faults?.hit("outbox:before-insert");
      const messageId = `message:${stableKey}`;
      const prior = messages.get(messageId);
      if (prior !== undefined) return prior;
      const message = Object.freeze({
        aggregateId,
        delivered: false,
        kind,
        messageId,
        sequence: messages.size + 1,
      });
      messages.set(messageId, message);
      faults?.hit("outbox:after-insert");
      return message;
    },
    markDelivered(messageId) {
      faults?.hit("outbox:before-ack");
      const message = messages.get(messageId);
      if (message === undefined)
        throw new Error("Outbox message does not exist");
      const delivered = Object.freeze({ ...message, delivered: true });
      messages.set(messageId, delivered);
      faults?.hit("outbox:after-ack");
      return delivered;
    },
    pending: () =>
      [...messages.values()]
        .filter((message) => !message.delivered)
        .sort((left, right) => left.sequence - right.sequence),
    redeliver(messageId) {
      const message = messages.get(messageId);
      if (message === undefined)
        throw new Error("Outbox message does not exist");
      const redelivered = Object.freeze({ ...message, delivered: false });
      messages.set(messageId, redelivered);
      return redelivered;
    },
  };
  return Object.freeze(store);
}
