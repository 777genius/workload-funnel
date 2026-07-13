import type {
  AuditRecord,
  AuditStore,
} from "@workload-funnel/workload-control/audit-history";

export interface AuditExportBatchV1 {
  readonly contractVersion: "workload-funnel.audit-export/v1";
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly records: readonly AuditRecord[];
  readonly chainHead: string;
}

export interface AuditSink {
  export(batch: AuditExportBatchV1): void;
}

export function verifyAuditChain(
  records: readonly AuditRecord[],
  verifyRecord: (record: AuditRecord) => boolean,
): void {
  let previousHash = "genesis";
  let sequence = 0;
  for (const record of records) {
    if (
      record.sequence !== sequence + 1 ||
      record.previousHash !== previousHash ||
      record.hash.length !== 64 ||
      !verifyRecord(record)
    )
      throw new Error("audit_chain_invalid");
    previousHash = record.hash;
    sequence = record.sequence;
  }
}

export function exportAuditRecords(
  store: AuditStore,
  sink: AuditSink,
  afterSequence: number,
  limit: number,
): AuditExportBatchV1 | undefined {
  if (
    !Number.isSafeInteger(afterSequence) ||
    afterSequence < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 1000
  )
    throw new Error("invalid_audit_export_page");
  const all = store.records();
  verifyAuditChain(all, (record) => store.verify(record));
  const records = all
    .filter((record) => record.sequence > afterSequence)
    .slice(0, limit);
  if (records.length === 0) return undefined;
  const batch = Object.freeze({
    chainHead: records.at(-1)?.hash ?? "genesis",
    contractVersion: "workload-funnel.audit-export/v1" as const,
    firstSequence: records[0]?.sequence ?? 0,
    lastSequence: records.at(-1)?.sequence ?? 0,
    records: Object.freeze(records),
  });
  sink.export(batch);
  return batch;
}
