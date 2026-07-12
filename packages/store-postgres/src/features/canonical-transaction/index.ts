import type {
  CanonicalTransaction,
  CanonicalTransactionTrace,
} from "@workload-funnel/workload-control/canonical-transaction-coordination";

export interface PostgresTransactionTraceSink {
  append(trace: CanonicalTransactionTrace): void;
}

export function createPostgresCanonicalTransaction(
  sink: PostgresTransactionTraceSink,
): CanonicalTransaction {
  const transaction: CanonicalTransaction = {
    execute(request, work) {
      const events: string[] = [`begin:${request.bundleId}`];
      for (const participantId of request.activeParticipants) {
        events.push(`declareLockIntents:${participantId}`);
      }
      try {
        for (const rank of request.ranks) {
          events.push(`physicalLock:${String(rank)}:SELECT FOR UPDATE`);
          events.push(`validateRank:${String(rank)}`);
          events.push(`applyRank:${String(rank)}`);
        }
        const value = work();
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
    },
  };
  return Object.freeze(transaction);
}
