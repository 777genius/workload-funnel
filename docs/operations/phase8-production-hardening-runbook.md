# Phase 8 production hardening rehearsal

## Scope and safety posture

This runbook is a WorkloadFunnel-owned deployment contract for consumption by
`hosted-agent-ops`. It does not modify that repository and contains no
project-specific lifecycle scripts. Every checked-in rehearsal uses synthetic
identities, repositories, histories, object clients, clocks, faults, and load.
Production and privileged starts remain disabled in
`phase8-hosted-agent-ops-deployment-contract.json`.
`phase8-synthetic-rehearsal-evidence.json` is the checked-in, non-production
handoff fixture consumed by the migration/rollback preflight test.

## Required verification

Run from an isolated WorkloadFunnel worktree:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:phase8
pnpm test
pnpm build
pnpm architecture:check
pnpm exports:check
git diff --check
```

Compare the SHA-256 digest of `docs/workload-funnel-architecture-plan.md`
before and after the change. No rehearsal launches an agent or workload,
provisions a host, contacts a real database or network service, invokes
systemd/D-Bus or HyperQueue, or opens a user project.

## Service and node identity

1. Create an enrollment request containing only the service kind, audience,
   node binding when applicable, exact credential fingerprint, and proof
   digest. Verify the fresh signed actor authorization before persistence.
2. Approve through an authenticated operator principal. Persist the actor
   evidence digest, identity, credential binding, operation receipt, and audit
   evidence atomically.
3. Advance the node boot epoch through the authority before accepting capacity,
   heartbeat, observation, or result publication from that boot.
4. Rotate before certificate expiry. Confirm that the superseded fingerprint
   and serial fail authentication.
5. On suspected compromise, quarantine first, cordon the Node, revoke the
   credential, rotate enrollment and ticket authorities, and reconcile every
   active or unknown execution. Do not infer process absence from revocation.

An unavailable, corrupt, non-durable, unauthenticated-write, or single-writer
authority keeps multi-node mode disabled.

## Controller failover and rollback

The signed durable authority inventory must include every affected node
launcher instance, scheduler gateway, runtime broker, result sealer, and
artifact-store mutation boundary. Reverify that authoritative inventory before
every close, drain, install, credential-disable, and reopen transition.
For every effect scope:

1. Close the scope and obtain a durable acknowledgement.
2. Drain the final critical section; a database queue reaching zero is not
   drain proof.
3. Advance canonical ownership to exactly the prior epoch plus one.
4. Install the complete `MutationFence`, its fingerprint, and all cross-scope
   high-watermarks at the still-closed authority.
5. Verify the acknowledgement byte-for-byte, disable old credentials, and only
   then reopen.

A crash resumes the durable phase. A stale claim, old writer epoch, lower owner
fence, or equal-version mismatched tuple performs zero final mutation. Rollback
uses the older compatible release as a new writer and a fresh epoch; it never
reactivates an old epoch or reverses the database schema.

## Node cordon, drain, and reboot

Cordon before drain. The durable drain coordinator retains every prior
execution identity and submits idempotent stop requests through their owners.
`unknown` or omission from a later inventory remains pending and retains
capacity. Terminal or absence state requires a fresh signed durable proof. An
initially empty drain requires two distinct authoritative inventory revisions.
Claim expiry permits a fenced coordinator takeover but proves nothing about
process state.

Reboot is requested only after every inventoried execution is terminal or
proven absent. After the new boot epoch is authenticated, the Node remains
cordoned. Inventory all old-boot execution evidence; unresolved evidence enters
`reconciliation_required`. Uncordon only after the maintenance operation is
complete and capacity, pressure, capability, and heartbeat observations for the
new boot are current.

## Artifact adapter replacement

The staged provider ID is immutable ResultManifest evidence. Local and object
verification/deletion select that exact provider. A missing provider fails
closed and never falls back.

Object production capability requires create-only allocation-scoped upload,
server checksum, scoped non-listing credentials, final mutation fencing, and a
separate manifest-bound exact-resource delete credential (`sp=d`, `sr=b`) for
each entry in the exact set. Prefix, container, and listing deletion authority
is forbidden. Object staging verifies the privileged signed seal receipt, tree
digest, complete seal/allocation/provider tuple, and scoped upload authority
before any reader or client call. Artifact stage and delete require an installed
durable authority record immediately before mutation. Sealing, quarantine,
two-phase delete, verified absence, and tombstone rules remain unchanged.

## Backup and disaster restore

Create a backup manifest at a fixed canonical stream cut. Record the accepted
count, terminal count, canonical history digest, database schema, acceptance
and audit high-watermarks, erasure watermark, durability profile, and cluster
incarnation. Retain external acceptance/audit and erasure watermarks in an
independent failure domain.

A restored service starts in `restore_quarantine` with acceptance, reservation,
submit, start, retry, finalize, archive, and delete closed. In order:

1. Verify accepted and terminal history against the backup manifest and
   external watermarks.
2. Rotate cluster and signing authority, advance namespace ownership, and
   install complete fences at every final authority.
3. Reconcile node WAL/unit, runtime, scheduler, artifact staging, and unknown
   execution inventory.
4. Rebuild projections from the recovered stream cut and replay outbox rows.
5. Replay the independent erasure ledger.
6. Prove old executions absent, stop them, adopt observation, or escalate.
7. Re-enroll nodes and require an empty unknown backlog.
8. Record audited approval before reopening admission.

Each transition requires a fresh, effect-specific, cryptographically verified
durable receipt. The final admission receipt revalidates the ordered stored
receipt chain after restart, including close/drain/install acknowledgements,
restore output, erasure replay, and execution reconciliation receipts.
Close, drain, install, restore, erasure, inventory, and execution evidence must
be the signed receipts emitted by those completed effect boundaries. A recovery
coordinator assertion containing only receipt IDs, counts, or completion flags
is not evidence. Authority receipt subjects must exactly match the signed
inventory, and each drain/install receipt must bind its preceding receipt.

Any accepted/audit watermark gap, history digest mismatch, erasure regression,
unknown execution, missing authority acknowledgement, or node enrollment gap
keeps quarantine closed.

## SLO and dashboard rehearsal

The Phase 8 dashboard contains confirmed acceptance, control and host-control
latency, reconciliation, identity/fencing, node maintenance, disaster recovery,
history loss, and burn-rate panels. The bounded integration contains 12 mixed
lightweight/heavy workloads, deterministic CPU/memory/IO/PID pressure, and
durable authority restart. It exercises canonical submit/status/cancel,
resource-control mapping, node persistence, and final artifact authority. It
must show protected host-control progress, zero starvation or stale external
effects, and no accepted or terminal history loss. Insufficient samples are not
a pass.
