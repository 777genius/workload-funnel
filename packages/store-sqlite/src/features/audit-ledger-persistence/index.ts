import type {
  AuditLedgerStore,
  AuditRecord,
} from "@workload-funnel/workload-control/audit-history";

export function createSqliteAuditLedgerStore(
  records: AuditRecord[],
): AuditLedgerStore {
  const store: AuditLedgerStore = {
    append(eventId, actorId, action, resourceId) {
      const prior = records.find((record) => record.eventId === eventId);
      if (prior !== undefined) return prior;
      const previousHash = records.at(-1)?.hash ?? "genesis";
      const record = Object.freeze({
        action,
        actorId,
        auditId: `audit-${String(records.length + 1).padStart(4, "0")}`,
        eventId,
        hash: `${previousHash}:${eventId}:${action}`,
        previousHash,
        resourceId,
        sequence: records.length + 1,
      });
      records.push(record);
      return record;
    },
    records: () => Object.freeze([...records]),
  };
  return Object.freeze(store);
}
