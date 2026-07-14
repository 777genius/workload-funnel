# WorkloadFunnel

> Turn unlimited demand into controlled execution.

WorkloadFunnel is a durable workload admission and execution system for agents,
jobs, builds, tests, benchmarks, and general processes.

The checked implementation includes the synthetic-verified Phase 0 through
Phase 8 slices. Production and privileged starts remain disabled until the
deployment capability, security, migration, and operator gates pass. The
architecture source of truth is:

- [Architecture and implementation plan](docs/workload-funnel-architecture-plan.md)

## Intent

WorkloadFunnel sits between higher-level orchestrators and concrete execution
runtimes:

```text
orchestrator
    -> WorkloadFunnel
        -> execution runtime or process adapter
            -> operating-system process boundary
```

It owns durable workload lifecycle, admission, resource allocation, execution
reconciliation, and multi-node capacity. It does not own project goals, agent
task decomposition, review strategy, or provider authentication.

## Architecture

The implementation will use:

- TypeScript;
- strict DDD inside Clean Architecture;
- feature-owned vertical slices inside every package;
- Postgres as the production source of truth;
- SQLite for embedded and desktop modes;
- systemd and cgroup v2 for Linux process ownership and resource enforcement;
- replaceable scheduler and executor adapters;
- HyperQueue as an optional, version-pinned batch scheduler adapter.

The domain and application packages must not import HyperQueue, systemd,
Postgres, SQLite, Docker, Kubernetes, Codex, Claude, or any project-specific
orchestrator.

## Workspace verification

The approved foundation is Node.js 24, pnpm 10.33.4, the
`@workload-funnel/*` package scope, Changesets, and the MIT License. The repository
and all packages remain private until the explicit transition gates in
[ADR-0001](docs/adr/0001-phase-0-foundation-decisions.md) pass.

The generated control profiles still advertise only their fixed local
capabilities and fail closed for unavailable production capabilities. Phase 8
adds synthetic multi-node identity, failover, maintenance, artifact,
disaster-recovery, SLO, load/chaos, and deployment rehearsal evidence without
enabling a production or privileged execution path. See the
[Phase 8 runbook](docs/operations/phase8-production-hardening-runbook.md).

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:phase8
pnpm feasibility:run
git diff --check
```

Individual gates are available as `format:check`, `lint`, `typecheck`, `test`,
`architecture:check`, and `exports:check`. `pnpm generate` regenerates the two
checked composition outputs from
`tooling/architecture/composition.source.json`.

## Status

No production enablement or public compatibility guarantee is implied by the
synthetic acceptance evidence. Tests must not run against real user projects,
real schedulers, real network services, or production host-control boundaries.
