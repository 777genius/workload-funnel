export interface AuditRecord {
  readonly auditId: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly hash: string;
}

export interface AuditStore {
  append(
    eventId: string,
    actorId: string,
    action: string,
    resourceId: string,
  ): AuditRecord;
  records(): readonly AuditRecord[];
}

export type AuditLedgerStore = AuditStore;
