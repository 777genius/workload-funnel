export const lifecycleTableNames = Object.freeze([
  "lifecycle_acceptance",
  "lifecycle_attempt",
  "lifecycle_cancellation",
  "lifecycle_erasure",
  "lifecycle_identity",
  "lifecycle_operation",
  "lifecycle_outbox",
  "lifecycle_run",
  "lifecycle_workload",
]);

export function lifecycleSchemaStatements(schema: string): readonly string[] {
  return Object.freeze([
    `CREATE TABLE ${schema}.lifecycle_identity (
      sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
    )`,
    `CREATE TABLE ${schema}.lifecycle_workload (
      workload_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      principal_id text NOT NULL,
      spec jsonb NOT NULL,
      spec_digest text NOT NULL,
      accepted_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE ${schema}.lifecycle_run (
      run_id text PRIMARY KEY,
      workload_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_workload(workload_id),
      attempt_id text NOT NULL UNIQUE,
      cancellation_desired text NOT NULL CHECK (cancellation_desired IN ('none', 'requested')),
      state text NOT NULL CHECK (state IN ('accepted', 'active', 'succeeded', 'failed', 'canceled')),
      terminal_outcome text CHECK (terminal_outcome IN ('succeeded', 'failed', 'canceled')),
      version integer NOT NULL CHECK (version > 0),
      CHECK (
        (terminal_outcome IS NULL AND state IN ('accepted', 'active')) OR
        (terminal_outcome = state AND state IN ('succeeded', 'failed', 'canceled'))
      )
    )`,
    `CREATE TABLE ${schema}.lifecycle_attempt (
      attempt_id text PRIMARY KEY,
      run_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_run(run_id),
      execution_generation text NOT NULL UNIQUE,
      state text NOT NULL CHECK (state IN (
        'queued', 'admitted', 'dispatching', 'starting', 'running',
        'publishing_results', 'unknown', 'reconciliation_required',
        'lost', 'succeeded', 'failed', 'canceled'
      )),
      cancellation_desired text NOT NULL CHECK (cancellation_desired IN ('none', 'requested')),
      start_authorization text NOT NULL CHECK (start_authorization IN ('authorized', 'revoked')),
      start_fence text NOT NULL,
      start_revocation_revision integer NOT NULL CHECK (start_revocation_revision >= 0),
      allocation_id text,
      dispatch_id text,
      execution_id text,
      result_manifest_id text,
      terminalization_intent jsonb,
      terminal_release_receipt_id text,
      attachment_rejections integer NOT NULL CHECK (attachment_rejections >= 0),
      reservation_request_revision integer NOT NULL CHECK (reservation_request_revision >= 0),
      version integer NOT NULL CHECK (version > 0)
    )`,
    `ALTER TABLE ${schema}.lifecycle_run
      ADD CONSTRAINT lifecycle_run_attempt_fk
      FOREIGN KEY (attempt_id) REFERENCES ${schema}.lifecycle_attempt(attempt_id)
      DEFERRABLE INITIALLY DEFERRED`,
    `CREATE TABLE ${schema}.lifecycle_operation (
      operation_id text PRIMARY KEY,
      caller_scope text NOT NULL,
      idempotency_key text,
      kind text NOT NULL CHECK (kind IN ('submit', 'cancel')),
      status text NOT NULL CHECK (status = 'committed'),
      resource_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK (
        (kind = 'submit' AND caller_scope IS NOT NULL AND idempotency_key IS NOT NULL) OR
        (kind = 'cancel' AND idempotency_key IS NULL)
      )
    )`,
    `CREATE UNIQUE INDEX lifecycle_submit_operation_key
      ON ${schema}.lifecycle_operation (caller_scope, idempotency_key)
      WHERE kind = 'submit'`,
    `CREATE TABLE ${schema}.lifecycle_acceptance (
      caller_scope text NOT NULL,
      idempotency_key text NOT NULL,
      spec_digest text NOT NULL,
      operation_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_operation(operation_id),
      workload_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_workload(workload_id),
      run_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_run(run_id),
      attempt_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_attempt(attempt_id),
      execution_generation text NOT NULL UNIQUE,
      PRIMARY KEY (caller_scope, idempotency_key)
    )`,
    `CREATE TABLE ${schema}.lifecycle_cancellation (
      operation_id text PRIMARY KEY REFERENCES ${schema}.lifecycle_operation(operation_id),
      run_id text NOT NULL REFERENCES ${schema}.lifecycle_run(run_id),
      status text NOT NULL CHECK (status IN ('cancellation_requested', 'already_terminal'))
    )`,
    `CREATE TABLE ${schema}.lifecycle_outbox (
      sequence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      message_id text NOT NULL UNIQUE,
      operation_id text NOT NULL UNIQUE REFERENCES ${schema}.lifecycle_operation(operation_id),
      aggregate_id text NOT NULL,
      event_type text NOT NULL CHECK (event_type IN ('WorkloadAccepted', 'RunCancellationRequested')),
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
    `CREATE TABLE ${schema}.lifecycle_erasure (
      operation_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      subject_principal_id text NOT NULL,
      pseudonym text NOT NULL,
      changed_count integer NOT NULL CHECK (changed_count >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`,
  ]);
}
