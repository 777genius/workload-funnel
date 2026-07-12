# WorkloadFunnel

> Turn unlimited demand into controlled execution.

WorkloadFunnel is a durable workload admission and execution system for agents,
jobs, builds, tests, benchmarks, and general processes.

The project is in Phase 0: decisions and skeleton. It has no production launch
path. Its architecture source of truth is:

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

## Phase 0 workspace

The approved foundation is Node.js 24, pnpm 10.33.4, the
`@workload-funnel/*` package scope, Changesets, and the MIT License. The repository
and all packages remain private until the explicit transition gates in
[ADR-0001](docs/adr/0001-phase-0-foundation-decisions.md) pass.

Only active code exists: one `workload-control/tenant-admission` vertical
slice and the two fixed Phase 0 control-profile composition outputs. The slice
demonstrates an immutable domain value, fail-closed domain policy, application
use case, feature public API, and focused tests. The profiles advertise only
their fixed local capabilities and return
`unschedulable_missing_capability` for absent later-phase capabilities. They do
not dispatch or launch work.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
git diff --check
```

Individual gates are available as `format:check`, `lint`, `typecheck`, `test`,
`architecture:check`, and `exports:check`. `pnpm generate` regenerates the two
checked composition outputs from
`tooling/architecture/composition.source.json`.

## Status

No production API or compatibility guarantee exists. Phase 0 does not include
host launching, scheduler/provider integration, persistence, production
workloads, or testing against real user projects.
