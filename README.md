# WorkloadFunnel

> Turn unlimited demand into controlled execution.

WorkloadFunnel is a durable workload admission and execution system for agents,
jobs, builds, tests, benchmarks, and general processes.

The project is currently in the architecture and foundation phase. Its source of
truth is:

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

## Status

No production API or compatibility guarantee exists yet. The repository remains
private until the architecture, security model, package names, and license are
explicitly approved.
