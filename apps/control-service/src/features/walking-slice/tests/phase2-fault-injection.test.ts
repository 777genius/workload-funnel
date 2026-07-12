import { describe, expect, it } from "vitest";

import {
  createDeterministicPostgresFaultInjector,
  createPostgresCanonicalTransaction,
} from "@workload-funnel/store-postgres/canonical-transaction";
import { createPostgresOutboxStore } from "@workload-funnel/store-postgres/transactional-outbox";
import {
  createDeterministicSqliteFaultInjector,
  createSqliteCanonicalTransaction,
} from "@workload-funnel/store-sqlite/canonical-transaction";
import { createSqliteOutboxStore } from "@workload-funnel/store-sqlite/transactional-outbox";
import type {
  CanonicalTransaction,
  CanonicalTransactionTrace,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";
import type { OutboxMessage } from "@workload-funnel/workload-control/control-event-delivery";

const transactionRequest = Object.freeze({
  activeParticipants: Object.freeze(["allocation-leasing"] as const),
  bundleId: "release-allocation-v1" as const,
  operationId: "release-1",
  ranks: Object.freeze([40, 50, 60, 160]),
});

describe("Phase 2 deterministic fault injection", () => {
  it.each([
    [
      "postgres",
      createPostgresCanonicalTransaction,
      createDeterministicPostgresFaultInjector,
    ],
    [
      "sqlite",
      createSqliteCanonicalTransaction,
      createDeterministicSqliteFaultInjector,
    ],
  ] as const)(
    "injects kills around every %s transaction/effect boundary",
    (_profile, create, createFaults) => {
      const boundaries = [
        "before-begin",
        "after-begin",
        "before-declare:allocation-leasing",
        "after-declare:allocation-leasing",
        "before-lock:40",
        "after-lock:40",
        "after-validate:40",
        "after-apply:40",
        "before-effect",
        "after-effect",
        "before-commit",
        "after-commit",
        "before-response",
      ];
      for (const boundary of boundaries) {
        const faults = createFaults(boundary);
        const traces: CanonicalTransactionTrace[] = [];
        const transaction: CanonicalTransaction = create(
          { append: (trace) => traces.push(trace) },
          faults,
        );
        expect(() =>
          transaction.execute(transactionRequest, () => "effect"),
        ).toThrow(boundary);
        expect(faults.visited).toContain(boundary);
        if (boundary === "before-begin") {
          expect(traces).toEqual([]);
        } else if (["after-commit", "before-response"].includes(boundary)) {
          expect(traces.at(-1)?.events).toContain("commit");
          expect(traces.at(-1)?.events).not.toContain("rollback");
        } else {
          expect(traces.at(-1)?.events.at(-1)).toBe("rollback");
        }
      }
    },
  );

  it.each([
    ["postgres", createPostgresOutboxStore],
    ["sqlite", createSqliteOutboxStore],
  ] as const)(
    "injects kills around every %s outbox boundary",
    (_profile, create) => {
      for (const boundary of [
        "outbox:before-insert",
        "outbox:after-insert",
        "outbox:before-ack",
        "outbox:after-ack",
      ]) {
        const rows = new Map<string, OutboxMessage>();
        const faults = {
          hit(current: string) {
            if (current === boundary)
              throw new Error(`synthetic_kill:${boundary}`);
          },
        };
        const store = create(rows, faults);
        if (boundary.includes("ack")) {
          const seed = create(rows);
          const message = seed.append("attempt-ready", "attempt-1", "ready-1");
          expect(() => store.markDelivered(message.messageId)).toThrow(
            boundary,
          );
        } else {
          expect(() =>
            store.append("attempt-ready", "attempt-1", "ready-1"),
          ).toThrow(boundary);
        }
      }
    },
  );
});
