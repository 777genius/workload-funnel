import type {
  InboxReceipt,
  InboxStore,
} from "@workload-funnel/workload-control/control-event-delivery";

export {
  createAsyncPostgresInboxStore,
  type AsyncPostgresInboxStore,
  type DurableInboxReceipt,
  type PostgresInboxExecutor,
} from "./async-postgres-inbox-store.js";

export function createPostgresInboxStore(
  receipts: Map<string, InboxReceipt>,
): InboxStore {
  const store: InboxStore = {
    complete(consumer, messageId) {
      const key = `${consumer}:${messageId}`;
      const prior = receipts.get(key);
      if (prior !== undefined) return prior;
      const receipt = Object.freeze({ completed: true, consumer, messageId });
      receipts.set(key, receipt);
      return receipt;
    },
    get: (consumer, messageId) => receipts.get(`${consumer}:${messageId}`),
  };
  return Object.freeze(store);
}
