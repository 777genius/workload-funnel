# ADR-0002: Phase 0.5 mandatory feasibility gates

- Status: Accepted for synthetic evidence; host capabilities remain gated
- Date: 2026-07-12
- Owners: WorkloadFunnel maintainers
- Plan references: Phase 0.5, sections 17.2, 18.3, 23.2, and 29.5

## Context

Phase 0.5 must retire high-risk assumptions before production lifecycle breadth
is built. The current workspace is an isolated container, not a disposable host
booted with systemd, and it has no dedicated Postgres or HyperQueue service. A
missing privilege, executable, kernel facility, or isolated service is evidence
of unsupported capability here, not permission to emulate a host PASS.

All fixtures use generated identifiers, temporary directories, bounded memory,
and in-memory models. They do not inspect or execute a user project or an
existing workload.

## Decision

The executable gate runner emits only `pass` or `unsupported` decisions under
the checked-in [evidence schema](evidence/phase-0-5.schema.json). The current
[isolated-workspace evidence](evidence/phase-0-5-isolated-workspace.json) records
the decisions below. Every decision
keeps `productionGate=closed`: Phase 0.5 evidence demonstrates feasibility but
does not enable production execution. Unsupported decisions include a stable
reason code and the exact evidence required on a disposable supported host.

| Gate                                                   | Capability decision in this workspace                                      | Applicable invariants      |
| ------------------------------------------------------ | -------------------------------------------------------------------------- | -------------------------- |
| Deterministic systemd nested lifecycle, WAL and limits | Unsupported; PID 1 is not systemd                                          | WF-INV-003/004/015/017     |
| Namespace anchor, FD pin, join and cleanup             | Unsupported; no verified privileged SCM_RIGHTS helper/host                 | WF-INV-003/043/049/053     |
| Foreground synthetic subscription-runtime ownership    | Unsupported as a host capability; duplicate journal model passes           | WF-INV-003/005/016/027     |
| Postgres canonical mutation, idempotency and outbox    | Unsupported; no dedicated `wf_feasibility_*` database                      | WF-INV-001/005/008/025     |
| Bounded capacity-ledger CAS                            | Unsupported; deterministic model passes, transactional contention unproved | WF-INV-007/042/046         |
| Pinned HyperQueue CLI reconciliation                   | Unsupported; v0.26.2 research CLI/service is absent                        | WF-INV-005/012/015/031/037 |
| Pressure and admission fail closed                     | Unsupported; policy model passes, host saturation isolation unproved       | WF-INV-013/015/019/023     |

The HyperQueue baseline is exactly v0.26.2 for research evidence, not an
approved production pin. Until exact operation-identity lookup proves ambiguous
submit reconciliation, the scheduler capability is unsupported and any future
adapter must be restricted to explicitly replayable workloads.

The namespace gate accepts no `JoinsNamespaceOf=`, pathname reopen, private-only
bind, or unpinned `/proc/<pid>/ns/mnt` downgrade. `pinnedExecutionPaths` remains
false until the complete restart, reboot, identity-substitution, setns, and
child-first-cleanup evidence in the emitted decision passes on a disposable
host.

## Reproducible commands

Install and run only synthetic probes:

```bash
pnpm install --frozen-lockfile
pnpm feasibility:run
pnpm test -- tooling/phase-0-5
```

Run one non-mutating gate probe by ID:

```bash
pnpm feasibility:run systemd_nested_lifecycle
pnpm feasibility:run namespace_anchor_fd_pin
pnpm feasibility:run foreground_runtime_ownership
pnpm feasibility:run postgres_atomic_acceptance
pnpm feasibility:run bounded_capacity_ledger_cas
pnpm feasibility:run pinned_hyperqueue_cli_boundary
pnpm feasibility:run pressure_admission_fail_closed
```

The runner does not accept host evidence by assertion alone. On a disposable
host, capture the requested command transcripts, service properties, WAL,
mountinfo, database rows, scheduler journal, binary digest, and crash-boundary
receipts named in each unsupported decision. A reviewed follow-up harness must
convert those observations to a PASS; environment variables merely make
prerequisites visible and cannot bypass a missing scenario.

## Consequences

The tenant-admission public contract now represents feasibility gate `pass` and
`unsupported` distinctly. Only passed names can become available capability
inputs. Both existing Phase 0 composition profiles continue to advertise none
of the new execution, database, scheduler, namespace, or pressure capabilities.

Synthetic transaction and runtime journals exercise deterministic model
semantics without claiming Postgres or provider-runtime behavior. The capacity
and pressure harnesses are reusable policy tests only; they do not prove
transactional concurrency, host saturation, protected-service isolation,
production stores, or host resource controllers.

## Reversal plan

Replace an unsupported decision only with checked evidence from an isolated
supported environment matching the emitted requirements. If a requested hard
resource, exact namespace lifecycle, foreground ownership, or unique scheduler
operation lookup cannot be enforced, retain the false capability and closed
admission rather than weakening the invariant.
