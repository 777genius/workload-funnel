import { createHash } from "node:crypto";

import type { PostgresQueryClient } from "./postgres-pool.js";

function canonical(value: unknown): string {
  if (value === undefined) throw new Error("postgres_canonical_json_invalid");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function tupleDigest(parts: readonly unknown[]): string {
  return createHash("sha256").update(canonical(parts)).digest("hex");
}

export async function completeCanonicalInbox(
  client: PostgresQueryClient,
  schema: string,
  input: Readonly<{
    consumerId: string;
    messageId: string;
    operationKind: string;
    payloadDigest: string;
  }>,
  signal?: AbortSignal,
): Promise<void> {
  await client.query(
    `INSERT INTO ${schema}.control_inbox
       (consumer_id, message_id, operation_kind, payload_digest)
     VALUES ($1, $2, $3, $4)`,
    [
      input.consumerId,
      input.messageId,
      input.operationKind,
      input.payloadDigest,
    ],
    signal,
  );
}

interface AuditTailRow extends Record<string, unknown> {
  readonly hash: string;
  readonly sequence_id: string;
}

export async function appendCanonicalAudit(
  client: PostgresQueryClient,
  schema: string,
  input: Readonly<{
    action: string;
    actorId: string;
    details: Readonly<Record<string, unknown>>;
    eventId: string;
    resourceId: string;
    tenantId: string;
  }>,
  signal?: AbortSignal,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`workload-funnel:audit:${schema}`],
    signal,
  );
  const tail = await client.query<AuditTailRow>(
    `SELECT sequence_id::text, hash FROM ${schema}.control_audit
      ORDER BY sequence_id DESC LIMIT 1 FOR UPDATE`,
    [],
    signal,
  );
  const previous = tail.rows[0];
  const previousSequence =
    previous === undefined ? 0 : Number(previous.sequence_id);
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0)
    throw new Error("postgres_audit_row_corrupt");
  const sequence = previousSequence + 1;
  const previousHash = previous?.hash ?? "genesis";
  const hash = createHash("sha256")
    .update(canonical({ ...input, previousHash, sequence }))
    .digest("hex");
  await client.query(
    `INSERT INTO ${schema}.control_audit
       (sequence_id, event_id, tenant_id, actor_id, action, resource_id,
        details, previous_hash, hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      sequence,
      input.eventId,
      input.tenantId,
      input.actorId,
      input.action,
      input.resourceId,
      canonical(input.details),
      previousHash,
      hash,
    ],
    signal,
  );
}
