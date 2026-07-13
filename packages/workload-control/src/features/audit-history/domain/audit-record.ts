export interface AuditRecord {
  readonly auditId: string;
  readonly eventId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly hash: string;
  readonly reason?: string;
  readonly policyVersion?: number;
  readonly previousState?: string;
  readonly nextState?: string;
  readonly correlationId?: string;
  readonly affectedResources?: readonly string[];
  readonly occurredAt?: number;
}

export interface AuditAppendDetails {
  readonly reason: string;
  readonly policyVersion: number;
  readonly previousState?: string;
  readonly nextState?: string;
  readonly correlationId: string;
  readonly affectedResources: readonly string[];
  readonly occurredAt: number;
}

export interface AuditStore {
  append(
    eventId: string,
    actorId: string,
    action: string,
    resourceId: string,
    details?: AuditAppendDetails,
  ): AuditRecord;
  records(): readonly AuditRecord[];
  readonly verify: (record: AuditRecord) => boolean;
}

export type AuditLedgerStore = AuditStore;

export function auditRecordHashMaterial(
  record: Omit<AuditRecord, "auditId" | "hash">,
): string {
  return JSON.stringify({
    action: record.action,
    actorId: record.actorId,
    affectedResources: record.affectedResources ?? null,
    correlationId: record.correlationId ?? null,
    eventId: record.eventId,
    nextState: record.nextState ?? null,
    occurredAt: record.occurredAt ?? null,
    policyVersion: record.policyVersion ?? null,
    previousHash: record.previousHash,
    previousState: record.previousState ?? null,
    reason: record.reason ?? null,
    resourceId: record.resourceId,
    sequence: record.sequence,
  });
}
