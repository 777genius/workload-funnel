export const controlPlaneTableNames = Object.freeze([
  "control_allocation",
  "control_audit",
  "control_capacity",
  "control_execution",
  "control_inbox",
  "control_namespace_ownership",
  "control_node_snapshot",
  "control_observation",
  "control_reconciliation",
  "control_service_identity",
]);

export function controlPlaneSchemaStatements(
  schema: string,
): readonly string[] {
  return Object.freeze([
    `DO $$
     BEGIN
       IF EXISTS (
         SELECT 1 FROM ${schema}.lifecycle_workload
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_run
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_attempt
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_acceptance
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_operation
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_identity
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_outbox
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_cancellation
         UNION ALL SELECT 1 FROM ${schema}.lifecycle_erasure
         LIMIT 1
       ) THEN
         RAISE EXCEPTION 'workload_funnel_v2_requires_explicit_legacy_import';
       END IF;
     END;
     $$`,
    `ALTER TABLE ${schema}.lifecycle_outbox
       ADD COLUMN delivered_at timestamptz,
       ADD COLUMN delivery_owner text,
       ADD COLUMN delivery_fence bigint CHECK (delivery_fence > 0),
       ADD COLUMN delivery_lease_until bigint CHECK (delivery_lease_until >= 0),
       ADD COLUMN delivery_attempts integer NOT NULL DEFAULT 0
         CHECK (delivery_attempts >= 0),
       ADD CONSTRAINT lifecycle_outbox_delivery_claim_consistent CHECK (
         (delivered_at IS NULL AND (
           (delivery_owner IS NULL AND delivery_fence IS NULL AND
            delivery_lease_until IS NULL) OR
           (delivery_owner IS NOT NULL AND delivery_fence IS NOT NULL AND
            delivery_lease_until IS NOT NULL)
         )) OR
         (delivered_at IS NOT NULL AND delivery_owner IS NOT NULL AND
          delivery_fence IS NOT NULL AND delivery_lease_until IS NULL)
       )`,
    `CREATE SEQUENCE ${schema}.control_delivery_fence_seq AS bigint`,
    `CREATE INDEX lifecycle_outbox_pending_delivery
       ON ${schema}.lifecycle_outbox (sequence_id)
       WHERE delivered_at IS NULL`,
    `CREATE TABLE ${schema}.control_inbox (
       consumer_id text NOT NULL,
       message_id text NOT NULL,
       operation_kind text NOT NULL,
       payload_digest text NOT NULL CHECK (payload_digest ~ '^[a-f0-9]{64}$'),
       completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       PRIMARY KEY (consumer_id, message_id)
     )`,
    `CREATE TABLE ${schema}.control_audit (
       sequence_id bigint PRIMARY KEY CHECK (sequence_id > 0),
       event_id text NOT NULL UNIQUE,
       tenant_id text NOT NULL,
       actor_id text NOT NULL,
       action text NOT NULL,
       resource_id text NOT NULL,
       details jsonb NOT NULL,
       previous_hash text NOT NULL CHECK (
         previous_hash = 'genesis' OR previous_hash ~ '^[a-f0-9]{64}$'
       ),
       hash text NOT NULL UNIQUE CHECK (hash ~ '^[a-f0-9]{64}$'),
       created_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
    `CREATE INDEX control_audit_tenant_sequence
       ON ${schema}.control_audit (tenant_id, sequence_id)`,
    `CREATE TABLE ${schema}.control_capacity (
       capacity_id text PRIMARY KEY,
       total_cpu_millis bigint NOT NULL CHECK (total_cpu_millis > 0),
       total_memory_mib bigint NOT NULL CHECK (total_memory_mib > 0),
       reserved_cpu_millis bigint NOT NULL DEFAULT 0 CHECK (reserved_cpu_millis >= 0),
       reserved_memory_mib bigint NOT NULL DEFAULT 0 CHECK (reserved_memory_mib >= 0),
       revision bigint NOT NULL CHECK (revision > 0),
       CHECK (reserved_cpu_millis <= total_cpu_millis),
       CHECK (reserved_memory_mib <= total_memory_mib)
     )`,
    `CREATE TABLE ${schema}.control_allocation (
       allocation_id text PRIMARY KEY,
       capacity_id text NOT NULL REFERENCES ${schema}.control_capacity(capacity_id),
       attempt_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_attempt(attempt_id),
       execution_generation text NOT NULL UNIQUE,
       node_id text NOT NULL,
       cpu_millis bigint NOT NULL CHECK (cpu_millis > 0),
       memory_mib bigint NOT NULL CHECK (memory_mib > 0),
       state text NOT NULL CHECK (state IN ('reserved', 'active', 'released')),
       owner_id text,
       owner_fence bigint NOT NULL DEFAULT 0 CHECK (owner_fence >= 0),
       lease_until bigint CHECK (lease_until >= 0),
       version bigint NOT NULL CHECK (version > 0),
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CHECK ((owner_id IS NULL AND lease_until IS NULL) OR
              (owner_id IS NOT NULL AND lease_until IS NOT NULL))
     )`,
    `CREATE TABLE ${schema}.control_namespace_ownership (
       namespace_id text PRIMARY KEY,
       writer_id text NOT NULL,
       writer_epoch bigint NOT NULL CHECK (writer_epoch > 0),
       version bigint NOT NULL CHECK (version > 0),
       payload jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
    `CREATE TABLE ${schema}.control_execution (
       execution_id text PRIMARY KEY,
       attempt_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_attempt(attempt_id),
       execution_generation text NOT NULL UNIQUE,
       allocation_id text NOT NULL UNIQUE REFERENCES ${schema}.control_allocation(allocation_id),
       namespace_id text NOT NULL REFERENCES ${schema}.control_namespace_ownership(namespace_id),
       writer_epoch bigint NOT NULL CHECK (writer_epoch > 0),
       owner_id text NOT NULL,
       owner_fence bigint NOT NULL CHECK (owner_fence > 0),
       state text NOT NULL CHECK (state IN ('starting', 'running', 'unknown', 'terminal')),
       version bigint NOT NULL CHECK (version > 0),
       payload jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
    `CREATE TABLE ${schema}.control_observation (
       source_id text NOT NULL,
       source_sequence bigint NOT NULL CHECK (source_sequence > 0),
       execution_id text NOT NULL REFERENCES ${schema}.control_execution(execution_id),
       execution_generation text NOT NULL,
       namespace_id text NOT NULL,
       writer_epoch bigint NOT NULL CHECK (writer_epoch > 0),
       owner_fence bigint NOT NULL CHECK (owner_fence > 0),
       state text NOT NULL CHECK (state IN ('starting', 'running', 'unknown', 'terminal')),
       observation_digest text NOT NULL CHECK (observation_digest ~ '^[a-f0-9]{64}$'),
       payload jsonb NOT NULL,
       observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       PRIMARY KEY (source_id, source_sequence)
     )`,
    `CREATE TABLE ${schema}.control_node_snapshot (
       node_id text PRIMARY KEY,
       boot_epoch text NOT NULL,
       source_sequence bigint NOT NULL CHECK (source_sequence > 0),
       version bigint NOT NULL CHECK (version > 0),
       payload jsonb NOT NULL,
       observed_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
    `CREATE TABLE ${schema}.control_reconciliation (
       operation_id text PRIMARY KEY,
       kind text NOT NULL,
       state text NOT NULL,
       payload jsonb NOT NULL,
       version bigint NOT NULL CHECK (version > 0),
       claimant_id text,
       claim_fence bigint NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
       claim_lease_until bigint CHECK (claim_lease_until >= 0),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CHECK ((claimant_id IS NULL AND claim_lease_until IS NULL) OR
              (claimant_id IS NOT NULL AND claim_lease_until IS NOT NULL))
     )`,
    `CREATE TABLE ${schema}.control_service_identity (
       identity_id text PRIMARY KEY,
       identity_kind text NOT NULL,
       credential_id text NOT NULL UNIQUE,
       credential_fingerprint text NOT NULL UNIQUE,
       state text NOT NULL CHECK (state IN ('active', 'disabled')),
       version bigint NOT NULL CHECK (version > 0),
       payload jsonb NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
     )`,
  ]);
}
