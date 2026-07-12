import type {
  ConsumerRegistration,
  DeadLetterRecord,
  DurableEvent,
} from "../domain/durable-stream.js";
import {
  advanceConsumerCursor,
  claimConsumer,
} from "../domain/durable-stream.js";

export interface DurableStreamStore {
  append(event: DurableEvent): DurableEvent;
  publishCommitted(): readonly DurableEvent[];
  after(position: number, limit: number): readonly DurableEvent[];
}

export interface ConsumerStateStore {
  get(consumerId: string): ConsumerRegistration | undefined;
  save(registration: ConsumerRegistration): void;
  deadLetter(record: DeadLetterRecord): void;
  getDeadLetter(
    consumerId: string,
    eventId: string,
  ): DeadLetterRecord | undefined;
}

export function createInMemoryDurableStreamStore(): DurableStreamStore {
  const events: DurableEvent[] = [];
  let nextPosition = 0;
  return Object.freeze({
    append(event: DurableEvent) {
      const prior = events.find((item) => item.eventId === event.eventId);
      if (prior !== undefined) {
        if (JSON.stringify(prior) !== JSON.stringify(event)) {
          throw new Error("event_id_conflict");
        }
        return prior;
      }
      events.push(Object.freeze({ ...event }));
      return event;
    },
    publishCommitted() {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event?.committed === true && event.streamPosition === undefined) {
          nextPosition += 1;
          events[index] = Object.freeze({
            ...event,
            streamPosition: nextPosition,
          });
        }
      }
      return Object.freeze(
        events.filter((event) => event.streamPosition !== undefined),
      );
    },
    after: (position: number, limit: number) =>
      Object.freeze(
        events
          .filter((event) => (event.streamPosition ?? 0) > position)
          .sort(
            (left, right) =>
              (left.streamPosition ?? 0) - (right.streamPosition ?? 0),
          )
          .slice(0, limit),
      ),
  });
}

export function consumeDurableBatch(
  registration: ConsumerRegistration,
  ownerId: string,
  now: number,
  leaseUntil: number,
  stream: DurableStreamStore,
  handle: (event: DurableEvent) => void,
  maximumAttempts = 3,
): Readonly<{
  registration: ConsumerRegistration;
  deadLetters: readonly DeadLetterRecord[];
}> {
  let current = claimConsumer(
    registration,
    ownerId,
    now,
    leaseUntil,
    registration.leaseFence,
  );
  const deadLetters: DeadLetterRecord[] = [];
  for (const event of stream.after(current.cursor, current.batchSize)) {
    if (event.streamPosition === undefined) continue;
    let attempts = 0;
    while (attempts < maximumAttempts) {
      attempts += 1;
      try {
        handle(event);
        break;
      } catch {
        if (attempts === maximumAttempts) {
          deadLetters.push(
            Object.freeze({
              attempts,
              consumerId: current.consumerId,
              eventId: event.eventId,
              reasonCode: "handler_failed",
              state: "dead_letter",
              streamPosition: event.streamPosition,
            }),
          );
        }
      }
    }
    current = advanceConsumerCursor(
      current,
      ownerId,
      current.leaseFence,
      event.streamPosition,
    );
  }
  return Object.freeze({
    deadLetters: Object.freeze(deadLetters),
    registration: current,
  });
}
