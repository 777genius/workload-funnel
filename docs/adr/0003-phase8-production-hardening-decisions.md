# ADR-0003: Phase 8 production hardening decisions

- Status: Accepted for synthetic verification
- Date: 2026-07-13
- Decision owners: WorkloadFunnel maintainers

## Context

Phase 8 requires multi-node identity, failover, node maintenance, production
artifact replacement, disaster recovery, SLO evidence, and deployment support.
The architecture plan also requires service identity and artifact-store choices
to be explicit before a production release. This ADR does not enable a
production or privileged execution path.

## Decisions

Multi-node service authentication uses mutually authenticated, short-lived
certificate credentials backed by a durable multi-writer compare-and-set
authority. Enrollment verifies a fresh signed authorization decision and
durably binds its actor, canonical `nodeId`, and exact credential fingerprint.
Credential rotation revokes the superseded credential. Revocation and
quarantine are monotonic. The
authority persists a per-credential boot epoch and source-sequence replay
cursor; a replay performs no authorized mutation.

Control-service replicas share the current namespace writer identity and epoch.
Replica failover uses short claims and a signed authoritative inventory of
every applicable scope and authority instance. Release cutover and rollback
still use the canonical ownership-transfer protocol: close all affected final
scopes, drain
old calls, advance `NamespaceOwnership`, install and acknowledge each complete
`MutationFence` and its cross-scope high-watermarks, disable old credentials,
and reopen. No replica-local leader token substitutes for the owner fence or
namespace writer epoch.

The production object adapter remains provider-SDK-neutral. A production client
must advertise create-only allocation-scoped upload, server checksum,
credential scoping, retention-only delete, and final mutation fencing. The
selected provider identity is persisted in staging evidence and
`ResultManifest`; verification or deletion cannot silently switch between the
local and object adapters. Local and object adapters share the result-management
contract suite. Object staging also verifies the privileged sealer's signed
receipt, complete seal tuple, tree digest, and allocation-scoped upload
authority before it reads or uploads bytes.

The initial SLO contract measures confirmed acceptance availability, control
and host-control p99 latency, reconciliation lag, stale-authority external
effects, and backup history loss. Synthetic Phase 8 acceptance requires
host-control p99 at or below 100 ms under a bounded 8-12 workload fixture and
zero stale-authority effects or lost accepted/terminal history records. These
are release gates, not claims about an unmeasured live deployment.

## Consequences

- Production composition must inject a durable authenticated identity store;
  an incapable store fails startup.
- Node messages are authenticated before authorization and replay cursor
  advancement.
- Reboot does not prove old execution absence. The node remains cordoned until
  old-boot executions are terminal, proven absent, or explicitly escalated.
- Artifact authority recovery is required before stage or delete mutation.
- Restore always begins with all effect gates closed and preserves immutable
  accepted and terminal history. Every transition consumes an effect-specific,
  signed durable receipt. Restore, inventory, close, drain, install, erasure,
  and execution reconciliation additionally carry the independently signed
  receipt emitted by the completed effect boundary; asserted receipt IDs,
  counts, phase strings, or booleans are insufficient.
- `hosted-agent-ops` consumes the checked-in deployment contract and runbook;
  WorkloadFunnel does not modify that external repository.

## Rejected alternatives

- Trust a node ID in request JSON or a scheduler transport identity.
- Treat certificate validity alone as enrollment authorization.
- Reuse a prior writer epoch during rollback.
- Mark executions absent because a drain claim or node heartbeat expired.
- Select an artifact adapter only by whichever capability is currently
  available.
- Treat a backup file, asynchronous replica, or dashboard as proof of zero RPO.
