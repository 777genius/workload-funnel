import type {
  CanonicalTransaction,
  CanonicalTransactionTrace,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface PostgresTransactionTraceSink {
  append(trace: CanonicalTransactionTrace): void;
}

export interface PostgresFaultInjector {
  hit(boundary: string): void;
}

export function createDeterministicPostgresFaultInjector(
  failAt: string,
): PostgresFaultInjector & Readonly<{ visited: readonly string[] }> {
  const visited: string[] = [];
  return Object.freeze({
    get visited() {
      return Object.freeze([...visited]);
    },
    hit(boundary: string) {
      visited.push(boundary);
      if (boundary === failAt)
        throw new Error(`synthetic_postgres_kill:${boundary}`);
    },
  });
}

export function createPostgresCanonicalTransaction(
  sink: PostgresTransactionTraceSink,
  faults?: PostgresFaultInjector,
): CanonicalTransaction {
  const transaction: CanonicalTransaction = {
    execute(request, work) {
      faults?.hit("before-begin");
      const events: string[] = [`begin:${request.bundleId}`];
      const result = (() => {
        try {
          faults?.hit("after-begin");
          for (const participantId of request.activeParticipants) {
            faults?.hit(`before-declare:${participantId}`);
            events.push(`declareLockIntents:${participantId}`);
            faults?.hit(`after-declare:${participantId}`);
          }
          for (const rank of request.ranks) {
            faults?.hit(`before-lock:${String(rank)}`);
            events.push(`physicalLock:${String(rank)}:SELECT FOR UPDATE`);
            faults?.hit(`after-lock:${String(rank)}`);
            events.push(`validateRank:${String(rank)}`);
            faults?.hit(`after-validate:${String(rank)}`);
            events.push(`applyRank:${String(rank)}`);
            faults?.hit(`after-apply:${String(rank)}`);
          }
          faults?.hit("before-effect");
          const value = work();
          faults?.hit("after-effect");
          faults?.hit("before-commit");
          events.push("commit");
          const trace: CanonicalTransactionTrace = Object.freeze({
            backend: "postgres",
            bundleId: request.bundleId,
            events: Object.freeze([...events]),
            operationId: request.operationId,
          });
          sink.append(trace);
          return Object.freeze({ trace, value });
        } catch (error) {
          events.push("rollback");
          sink.append(
            Object.freeze({
              backend: "postgres",
              bundleId: request.bundleId,
              events: Object.freeze([...events]),
              operationId: request.operationId,
            }),
          );
          throw error;
        }
      })();
      faults?.hit("after-commit");
      faults?.hit("before-response");
      return result;
    },
  };
  return Object.freeze(transaction);
}
