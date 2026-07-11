# AGENTS.md

## Project Intent

WorkloadFunnel is a universal workload admission, resource allocation, and
execution control system. It is designed first for AI agents and their child
processes, but its domain must also support builds, tests, benchmarks, and
general workloads without agent-provider coupling.

Start with:

```text
docs/workload-funnel-architecture-plan.md
```

## Architecture Rules

Use strict DDD inside Clean Architecture, organized as feature-owned vertical
slices.

The decomposition is two-dimensional:

```text
repository
  -> package or bounded context
      -> business feature
          -> domain, application, contracts, adapters, tests
```

Packages are not a substitute for feature slicing. Every package that grows
beyond a trivial adapter must be divided under `src/features/<feature-name>`.

Each feature owns its use cases, domain policy, application contracts, public
API, and tests. A feature may omit layers that it does not need. Do not create
empty architecture folders for symmetry.

Application ports are stored as feature-owned `application/contracts`. Do not
create a repository-wide `ports`, `services`, `helpers`, `common`, or `utils`
dumping ground.

Cross-feature imports must use a feature's public `index.ts`, public read model,
command, or domain event. Importing another feature's internal files is
forbidden.

Each canonical aggregate mutation has one owning feature. Other features and
adapters request changes through its public commands/events; they must not
implement a competing state transition.

`workload-control/node-lifecycle` is the sole canonical owner of the Node
aggregate. Node-execution reports requests and observations only.

`workload-control/execution-reconciliation` is the sole canonical owner of
Execution. `workload-control/result-management` is the sole canonical owner of
ResultManifest. Node, runtime, scheduler, retention, and artifact adapters emit
fenced observations or commands only.

Pure adapter packages may be sliced by the application contract operations they
implement, but they own no business policy. Admission, fairness, placement,
retry, cancellation, and lifecycle decisions remain in their domain/application
features.

## Responsibility Boundaries

WorkloadFunnel owns:

- workload intent acceptance and idempotency;
- run, attempt, allocation, and dispatch lifecycle;
- tenant admission, quotas, fairness, and priority aging;
- node capacity and pressure observations;
- scheduler-independent dispatch reconciliation;
- process ownership through executor adapters;
- resource enforcement through executor capabilities;
- result manifests, retention state, and audit events;
- transactional outbox/inbox delivery;
- leases, immutable execution generations, owner fences, and namespace writer
  epochs.

WorkloadFunnel does not own:

- project goals or task decomposition;
- producer/reviewer/integration role strategy;
- benchmark selection or scoring policy;
- worktree review or git integration policy;
- Codex, Claude, or another provider's authentication;
- raw tmux, registry, or project-specific file manipulation;
- a claim of exactly-once execution.

`subscription-runtime` remains the provider execution and safety kernel.
WorkloadFunnel may depend on a versioned runtime client contract through an
adapter. `subscription-runtime` must never import WorkloadFunnel.

For agent workloads, WorkloadFunnel's node executor owns the outer systemd and
cgroup process boundary. `subscription-runtime` runs in foreground inside that
boundary and owns provider/session semantics. Do not create two host-level
process owners or independent launch loops. The runtime bridge is composed only
inside this node-owned path; the control service must not call it as a direct
launcher.

The node boundary is privilege-separated: an unprivileged networked node agent
and a minimal root launcher communicating through a typed, peer-checked Unix
socket. The agent and workloads receive no direct systemd mutation permission;
the launcher has no network, database, scheduler, or secret-store access and
constructs units only from validated tickets and allowlisted profiles.

`hosted-agent-ops` deploys and configures WorkloadFunnel. Operational scripts
must not become the canonical workload lifecycle implementation.

## Adapter Independence

The domain and application layers must not import or expose types from:

- HyperQueue;
- systemd or D-Bus;
- Postgres or SQLite clients;
- Docker, Kubernetes, Nomad, or cloud SDKs;
- Codex, Claude, or another agent runtime.

External identifiers are stored only in adapter-owned dispatch mappings. Every
adapter reports explicit capabilities. If a required capability is unavailable,
the operation fails closed or selects another adapter; it must not silently
downgrade safety.

Caller identity, actor, and effective tenant come from authenticated transport
identity and authorization policy, never trusted request fields. Persist
requested and effective policy values separately where authorization or
normalization can change them.

## Reliability Invariants

- API acceptance is idempotent by caller-scoped idempotency key.
- Delivery is at least once; handlers must deduplicate commands and events.
- A workload run, execution attempt, resource allocation, scheduler dispatch,
  and process execution are distinct concepts.
- Only one execution generation may own the outer process for an attempt.
- Lease takeover increments owner fence without changing process identity;
  writer epochs reject stale control-plane deployments.
- Missing heartbeat first becomes `unknown`, never immediately `failed`.
- Ambiguous side-effectful workloads are not automatically replayed.
- Scheduler completion is not canonical workload success.
- Cancellation is desired state and is complete only after observation or an
  explicit terminal reconciliation decision.
- Platform code never serializes secret values into workload specifications,
  scheduler payloads, events, manifests, or general logs; secret-bearing child
  output follows an explicit quarantine/redaction policy.
- A terminal workload may outlive deleted result bytes through a tombstone.
- Revisioned operation gates must block queued and new matching effects at the
  final launcher/gateway boundary during restore, rollback, or critical pressure.

## Process Safety

On Linux, use systemd transient services and cgroup v2 through a supported
systemd interface. Do not manipulate cgroupfs directly when systemd owns the
hierarchy.

Every allocation must have deterministic process ownership, `KillMode` covering
the complete process tree, bounded PIDs, explicit memory policy, CPU/IO weights,
and classified OOM/pressure outcomes.

Do not parse arbitrary LLM shell commands to infer resource requirements. The
caller submits a structured resource request. The executor enforces the granted
resource envelope regardless of what descendants execute.

## Testing Safety

Never test launch, provisioning, process control, task assignment, runtime
execution, scheduler integration, or cancellation against real user projects.

Use only:

- in-memory adapters;
- temporary directories;
- synthetic repositories;
- synthetic provider/runtime adapters;
- dedicated sandbox Postgres/SQLite databases;
- disposable systemd units with a test prefix;
- isolated HyperQueue test servers and workers.

Tests must prove duplicate delivery, crash recovery, stale fencing, ambiguous
outcomes, cancellation races, adapter replacement, and absence of secrets.

## Code Quality

- Prefer immutable domain values and explicit state transitions.
- Keep framework and process APIs in adapters.
- Use structured parsers and schemas at every external boundary.
- Prefer composition over inheritance.
- Do not add an abstraction without a real substitution or invariant boundary.
- Do not hide domain decisions inside repositories, controllers, or DTO mappers.
- Avoid project-specific enums in universal packages.
- Preferred file size is below 300 lines; hard cap is 800 lines.
- Split by feature, aggregate policy, use case, contract, adapter, or fixture.
- Add comments only where an invariant or failure mode is not obvious from code.

## Change Discipline

- Use conventional commits.
- Do not use agent or AI prefixes in branch names.
- Do not modify unrelated or unowned work.
- Keep generated files out of manual edits.
- Update the architecture plan or an ADR when changing a fundamental boundary,
  lifecycle state, delivery guarantee, or source-of-truth rule.
