import type {
  OutboxMessage,
  OutboxStore,
} from "@workload-funnel/workload-control/control-event-delivery";

export function createSqliteOutboxStore(
  messages: Map<string, OutboxMessage>,
): OutboxStore {
  const store: OutboxStore = {
    append(kind, aggregateId, stableKey) {
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
      return message;
    },
    markDelivered(messageId) {
      const message = messages.get(messageId);
      if (message === undefined)
        throw new Error("Outbox message does not exist");
      const delivered = Object.freeze({ ...message, delivered: true });
      messages.set(messageId, delivered);
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
