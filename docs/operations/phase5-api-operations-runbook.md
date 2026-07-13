# Phase 5 API and operations runbook

## Safety posture

Phase 5 exposes only the synthetic and observation-safe execution profiles that
were already enabled. Production and privileged starts remain disabled in the
signed compatibility manifest. These procedures use disposable fixtures and do
not authorize launches against user projects or live services.

Authentication is completed from the verified bearer, Unix-peer, or mTLS
transport credential before authorization evaluates the requested tenant scope.
Request JSON cannot set the actor, authenticated principal, or effective tenant.

## Public operations

The versioned HTTP surface provides workload submit, observe, cancel, operation
status, result access, capacity, admission explanation, reconciliation items,
durable events, consistent workload snapshots, retention, erasure, audit,
metrics, and health. Every mutation uses
`workload-funnel.mutation/v1` and is deduplicated by effective tenant,
authenticated principal, operation kind, and idempotency key.

Bootstrap an event consumer from `GET /v1/snapshots/workloads`, retain its
snapshot watermark and signed cursor, and then call `GET /v1/events`. Cursors
are bound to tenant, filters, partition, schema, and snapshot watermark. A
`cursor_expired` response requires a new snapshot; it must never be converted
to an empty page. Slow consumers have bounded lag, replay horizon, count, byte,
batch, and lease budgets. A consumer in `bootstrap_required` no longer blocks
compaction.

## Retention and erasure

Retention deletion remains a two-phase result-management operation. API
acceptance only prepares the owner operation; it does not claim that bytes are
gone. Legal hold records an erasure request as `pending_legal_hold` and performs
no pseudonymization or artifact deletion. Completed erasure pseudonymizes owner
records and is recorded in the independent erasure sequence before affected
projections are served after restore. All security-sensitive operations append
actor, reason, policy version, prior/next state, correlation, resources, and
time to the tamper-evident audit chain.

## Upgrade and rollback preflight

Verify the detached Ed25519 signature on
`compatibility-manifest.phase5.json`. Preflight must include active and rollback
release manifests, offline-but-supported nodes, queued events, retained replay
schemas, active tickets and key IDs, and the current database schema. Producers
emit only the common readable/writable intersection.

Use the migration order `expand -> dual_write -> backfill -> validate ->
switch_reads -> stop_old_writes -> rollback_wait -> contract`. Backfill must be
checkpointed and resumable, and DDL uses bounded lock and statement timeouts.
Do not enter `contract` while an old binary or retained replay data needs the
old schema.

Before rollback, close `process_start`, `automatic_retry`, and `result_delete`.
Wait for durable final-authority acknowledgements at the same gate revision;
an in-database closure alone is not a completed freeze. Observation,
cancellation propagation/finalization, dispatch cancel, and process stop remain
available. Rollback never performs a destructive database downgrade.

## Health and dashboards

Liveness means the process can make internal progress. Readiness means the
dependencies needed for the advertised API semantics are available. Degraded
mode is explicitly `degraded_observe_cancel_only`; node schedulability remains
a separate signal. The checked-in dashboard definitions cover lifecycle,
latency, ambiguity, delivery backlog, pressure, allocation, results, and
heartbeat freshness without workload-ID metric labels.
