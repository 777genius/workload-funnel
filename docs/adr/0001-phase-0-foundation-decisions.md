# ADR-0001: Phase 0 foundation decisions

- Status: Accepted
- Date: 2026-07-12
- Owners: WorkloadFunnel maintainers
- Plan references: Sections 8, 29.12, 30 Phase 0, 33 items 1-2, and 35

## Context

Phase 0 needs one reproducible TypeScript toolchain and unambiguous legal and
package identities before independently integrated packages can accumulate.
The architecture plan selects TypeScript but leaves license, package manager,
runtime line, npm organization, and the private-to-public transition open.

The current build host supports Node.js 24 and pnpm 10. The repository has no
published compatibility promise or production behavior.

## Decision

- The product and repository name is `WorkloadFunnel` / `workload-funnel`.
- Node.js 24 is the sole Phase 0 runtime line (`>=24 <25`), with 24.16.0 pinned
  for local tooling and CI. Runtime upgrades require CI evidence and an ADR
  update.
- pnpm 10.33.4 is the monorepo package manager. The `packageManager` field and
  lockfile are authoritative; CI installs with `--frozen-lockfile`.
- Changesets 2.29.8 owns package version intent and changelog preparation.
  Changesets may version private packages so history begins before publication.
- The MIT License is approved for original WorkloadFunnel code.
- `@workload-funnel/*` is the approved npm package scope. Scope ownership must
  be verified before any publish operation; Phase 0 does not reserve or publish
  it automatically.
- The repository and every workspace package remain private during Phase 0.
  Public exports describe architectural API boundaries, not npm availability.
- A public transition requires a reviewed threat model, verified scope
  ownership, provenance-enabled release CI, secret scanning, package-content
  inspection, and an ADR that changes each intended package's `private` flag.
  No package is published by the Phase 0 CI workflow.

## Consequences

Contributors use one pinned install path and one lockfile. Node 22 and alternative
package managers are not supported by this phase. MIT notices must be
preserved. Consumers cannot install a package from npm until the explicit public
transition has passed; workspace exports are nevertheless checked now.

The API transport and initial production deployment profile remain undecided.
This ADR does not approve production launches, Postgres/SQLite behavior,
HyperQueue, systemd, provider runtime, or artifact-store implementations.

## Alternatives considered

- npm workspaces provide fewer monorepo filtering and strict-linking controls.
- Yarn would add a second toolchain that the current host does not already use.
- Apache-2.0 adds an explicit patent grant, but its notice and contribution
  requirements add governance overhead that is not justified for this private
  foundation. The public-transition ADR must reassess patent policy.
- Publishing immediately would expose an unreviewed contract and depend on
  unverified npm-scope ownership.

## Verification

`pnpm install --frozen-lockfile`, the root engine declaration, CI runtime setup,
Changesets configuration, package-export checks, and the checked-in license
provide executable or reviewable evidence for these decisions.

## Reversal plan

Change the runtime or package manager only in a migration ADR that updates CI,
the lockfile, and local commands atomically. A package-scope or license change
must happen before a public release and receive legal and governance review;
already released artifacts are not rewritten.
