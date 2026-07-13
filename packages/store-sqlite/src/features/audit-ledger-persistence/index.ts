import type {
  AuditLedgerStore,
  AuditRecord,
} from "@workload-funnel/workload-control/audit-history";
import { auditRecordHashMaterial } from "@workload-funnel/workload-control/audit-history";

export function createSqliteAuditLedgerStore(
  records: AuditRecord[],
): AuditLedgerStore {
  const store: AuditLedgerStore = {
    append(eventId, actorId, action, resourceId, details) {
      const prior = records.find((record) => record.eventId === eventId);
      if (prior !== undefined) {
        const repeatedHash = createHash("sha256")
          .update(
            auditRecordHashMaterial({
              action,
              actorId,
              eventId,
              previousHash: prior.previousHash,
              resourceId,
              sequence: prior.sequence,
              ...details,
            }),
          )
          .digest("hex");
        if (repeatedHash !== prior.hash)
          throw new Error("audit_event_id_conflict");
        return prior;
      }
      const previousHash = records.at(-1)?.hash ?? "genesis";
      const sequence = records.length + 1;
      const stableDetails =
        details === undefined
          ? undefined
          : {
              ...details,
              affectedResources: Object.freeze([...details.affectedResources]),
            };
      const hash = createHash("sha256")
        .update(
          auditRecordHashMaterial({
            action,
            actorId,
            eventId,
            previousHash,
            resourceId,
            sequence,
            ...stableDetails,
          }),
        )
        .digest("hex");
      const record = Object.freeze({
        action,
        actorId,
        auditId: `audit-${String(records.length + 1).padStart(4, "0")}`,
        eventId,
        hash,
        previousHash,
        resourceId,
        sequence,
        ...stableDetails,
      });
      records.push(record);
      return record;
    },
    records: () => Object.freeze([...records]),
    verify: (record) =>
      createHash("sha256")
        .update(auditRecordHashMaterial(record))
        .digest("hex") === record.hash,
  };
  return Object.freeze(store);
}
import { createHash } from "node:crypto";
