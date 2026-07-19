# ADR-0004: Production enablement is a verified deployment receipt

- Status: Accepted for the control-plane lane
- Date: 2026-07-19
- Decision owners: WorkloadFunnel maintainers

## Context

The Phase 8 repository proved production-shaped behavior with synthetic and
disposable fixtures, but its Postgres composition was only a lifecycle adapter
and deliberately refused all starts. Several Postgres-named adapters were
synchronous ports backed by caller-provided maps. The control service had no
deployable network entrypoint. Flipping a static boolean would therefore have
made an untrue production claim.

The production boundary spans two separately owned lanes. This change owns the
control-service and Postgres control-plane lane. The node/process lane continues
to own the outer systemd process, cgroup enforcement, the typed privileged
launcher socket, runtime bridge, result sealer, and scheduler mutation gateway.
The control service must never become a competing process launcher.

## Decision

There is no global positive production switch. The checked composition keeps a
static `productionStartsEnabled = false` declaration for callers that have no
verified deployment context. A constructed service reports
`productionStartsEnabled: true` only after all checks below finish successfully
for that exact process configuration.

Startup requires a short-lived Ed25519-signed capability receipt. The receipt
binds:

- the `control-postgres` profile and exact deployment configuration digest;
- the signed compatibility-manifest digest;
- one sorted, duplicate-free dependency record for every required capability;
- each provider ID, contract version, configuration digest, evidence digest,
  verification time, and expiry;
- the receipt signer, issue time, validity interval, and expiry.

The configuration digest excludes password and private-key bytes. It includes
the Postgres identity and bounded pool settings, TLS certificate/CA digests,
network limits, namespace writer identity and epoch, capacity profile, mTLS
caller bindings, and authorization policy. A missing, extra, expired,
mismatched, malformed, or incorrectly signed dependency rejects startup.

The receipt must include both the control-plane capabilities implemented here
and the node/process capabilities supplied by that lane. In particular, the
receipt cannot be issued without verified foreground runtime ownership,
deterministic systemd process ownership, typed launcher brokering, pinned
execution paths, complete process-tree cancellation, result sealing, and the
scheduler mutation gateway. This is dependency evidence, not permission for
the control service to invoke those boundaries directly.

## Durable control-plane boundary

Postgres migration version 2 adds durable tables for the audit chain, command
inbox, delivery-fenced outbox, capacity and allocations, namespace ownership,
execution ownership and observations, node observations, reconciliation work,
and service transport identities. Migration versions and SHA-256 checksums are
ordered and immutable. Startup rejects missing, unknown, out-of-order, changed,
partially owned, or incompletely installed schema state.

The network-service startup path is read-only with respect to migrations. An
operator-controlled migration job must install the exact schema first; startup
verifies the ledger, checksums, objects, sequences, and ownership and refuses a
missing schema rather than creating it under serving credentials. The
control-service binary exposes this separate job as `--migrate --config PATH`;
it closes its pool without constructing or opening the network server.

Version 1 never supported production startup, so version 2 deliberately rejects
a non-empty version 1 lifecycle schema instead of manufacturing missing inbox,
audit, and delivery evidence. Such data requires an explicit, reviewed import
into a fresh version 2 schema. The rejection is transactional and leaves the
version 1 schema and migration ledger unchanged.

Workload acceptance and cancellation retain their canonical owner and use one
serializable transaction for lifecycle state, idempotency operation, command
inbox receipt, tamper-evident audit record, and transactional outbox event.
Principal erasure retains its exact
`(tenant, subject principal, pseudonym, operation)` replay tuple and records its
inbox and audit effects in the same transaction. Caller scope continues to use
length-prefixed UTF-8 tuples, so delimiter placement cannot merge tenants,
namespaces, principals, or idempotency keys.

Allocation reservation locks the capacity record, enforces the granted CPU and
memory totals, and creates one allocation per attempt and execution generation.
Owner takeover increments a durable fence without changing process identity;
execution adoption requires that exact live allocation lease and fence while
preserving the execution generation. Namespace mutation uses version and
writer-epoch compare-and-set. Execution
observations require the exact current namespace epoch, execution generation,
allocation owner fence, and unexpired allocation lease, and deduplicate the
exact source ID and source sequence tuple.

Outbox claims use `FOR UPDATE SKIP LOCKED`, a database sequence fence, and a
bounded lease. Acknowledgement requires the exact owner and current delivery
fence. Inbox identity is the two-column `(consumer, message)` key; it is never a
delimiter-concatenated string. Reconciliation work has a versioned durable
payload and a fenced claimant lease.

## Network and lifecycle boundary

The production control service is a bounded HTTPS server with mandatory,
verified client certificates. The TLS socket supplies caller identity; no HTTP
header or request field may assert a principal or effective tenant. The signed
configuration binds each certificate fingerprint to a credential and principal,
and startup verifies the same active identity in Postgres before listening.
Authorization derives effective tenant and limits from the configured policy.

The server bounds connection count, headers, body bytes, request duration,
keep-alive duration, and drain duration. It exposes separate liveness and
readiness endpoints. Readiness rechecks the exact migration ledger, configured
capacity profile, durable stores, service identities, canonical bundles, and
the namespace writer fence. Draining closes admission and new connections,
allows bounded in-flight completion, aborts remaining database calls at the
deadline, closes idle/active sockets, and then closes the Postgres pool. SIGINT
and SIGTERM enter this same idempotent close path.

The config file must be an owner-only regular file opened with `O_NOFOLLOW`,
have a bounded size, and contain exactly the database and server documents.
Startup errors emit only stable codes and never render the configuration,
credentials, certificates, request bodies, or driver errors.

The always-on regression suite uses safe transactional fakes. The live SQL
integration suite runs only when `WF_CONTROL_POSTGRES_TEST_URL` names a
dedicated database beginning with `wf_control_test_`. It creates and drops only
random `wf_control_*` schemas inside that database and covers migration
rollback/corruption, canonical bundles, restart durability, multi-writer
fences, lease takeover, pool exhaustion, abort, and shutdown. When explicit
test-only TLS certificate/key paths and a listener port are also provided, it
constructs the complete production composition over TLS, signs the exact
capability/configuration receipt, verifies the migration/identity/writer gates,
opens the bounded listener, becomes ready, and closes the listener and real pool.
It never launches or inspects a user workload or project.

## Enablement boundary

This ADR makes the control-plane half truthfully deployable; it does not by
itself authorize a production workload start. A deployment may issue the
complete capability receipt only after the separately owned node/process lane
provides and verifies all required providers and final mutation fences. Until
then, startup fails closed before opening the network listener.

The following remain node/process-lane dependencies:

- node-agent composition for durable observation and cancellation propagation;
- the peer-checked unprivileged-agent to root-launcher Unix socket;
- allowlisted transient systemd service and cgroup v2 construction;
- outer-process adoption, stop, absence, and ambiguous-outcome reconciliation;
- the foreground `subscription-runtime` bridge inside the node-owned boundary;
- result-sealer and final artifact mutation authority integration;
- scheduler mutation gateway installation and its dominating writer fence;
- a signed compatibility receipt issuer that verifies those deployed contracts.

These dependencies must use the durable commands, observations, generations,
epochs, and fences defined by the control plane. They must not import the
control service as a direct launcher or create a second host-level process
owner.

## Consequences

Production startup now requires operator provisioning of the schema, active
mTLS identities, initial namespace writer record, capacity profile, compatible
node/process providers, and a fresh signed receipt. This is intentionally more
work than starting a synthetic profile. Missing evidence is an unavailable
service, never an implicit downgrade.

SQLite and synthetic profiles remain unchanged and do not consume the
production receipt. Existing disposable production-readiness rehearsals keep
their own `productionStartsEnabled: false` evidence because they do not prove a
complete deployed capability profile.
