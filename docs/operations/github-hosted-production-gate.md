# GitHub-hosted production gate

The `production-readiness` job in `.github/workflows/ci.yml` is a manual
evidence runner for the disposable-host gate. The CI workflow retains its
normal `pull_request` and `push` verification, while this job has an exact
`workflow_dispatch` event condition that prevents automatic execution.
A dispatch requires `expected_sha`; the job rejects it unless it is exactly 40
lowercase hex, exactly equals `github.sha`, and exactly equals the checked-out
`HEAD`. The checkout action also receives that exact `github.sha`. The job uses
a new public GitHub-hosted `ubuntu-24.04` VM, grants only `contents: read`, and
does not enable production or privileged starts.

GitHub exposes a `workflow_dispatch` entry only after `ci.yml` is present on the
repository's default branch. Therefore the first manual run is available only
after the reviewed workflow lands on that branch. No standalone production-gate
workflow exists, and the production job remains ineligible for `push`,
`pull_request`, scheduled, or reusable-workflow events.

The new VM is not itself an attestation. Before any workload-facing mutation,
the hosted wrapper independently requires non-interactive root sudo, systemd as
PID 1, unified cgroup v2 with the required controllers, a reachable Docker
server, bounded host pressure, at least four CPUs, 14 GiB RAM, and 12 GiB free
disk, and no pre-existing WorkloadFunnel user, path, process, unit, container,
image, network, or volume state. A missing observation or tool is a refusal,
not an unsupported downgrade.

The workflow builds the exact checked-out commit before copying it to a
root-owned review tree. The wrapper then:

1. downloads the official versioned AWS CLI 2.35.23 archive, requires SHA-256
   `db818de6dd8096d19ac275341721f96bcd70511377446d11c9149a5ed71f8b43`
   before signature verification or installation, accepts only the detached
   signature from the documented AWS signer fingerprint
   `FB5DB77FD5C118B80511ADA8A6310ACC4672475C`, installs it under the owned host
   root, and binds the canonical real executable, digest, and exact version;
2. rejects any preinstalled PostgreSQL 18 client, accepts a signing-key bundle
   containing only fingerprint `B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8`,
   and installs only `postgresql-client-18=18.4-1.pgdg24.04+1` from a dedicated
   source list, keyring, package-list state, and archive cache below the owned
   host root. No global APT source or list state can select the package. The
   signed PGDG metadata is authenticated before the exact `psql` 18.4 identity
   is accepted;
3. downloads HyperQueue 0.26.2 from its official release and verifies SHA-256
   `e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5`;
4. pulls only the immutable Postgres, Azurite, MinIO, and MinIO Client image
   references used by the reviewed disposable-host gate;
5. creates a dedicated loop-backed XFS filesystem mounted with `prjquota`,
   mode-`0700` allocation and project-quota roots, and the synthetic non-login
   user;
6. copies or resolves every gate executable to a canonical root-owned identity;
7. copies the complete runtime dependency closure, including
   `@azure/storage-blob` and every transitive package target, into root-owned
   custody, records every external target file digest and every internal
   and repository-owned target file digest plus every internal resolution
   link-to-target mapping in a non-writable integrity manifest,
   seals the same bytes in a deterministic reviewed bundle, and recreates only
   root-owned links whose canonical targets stay inside the reviewed root. The
   hosted wrapper rehashes the actual target files, reinventories every link,
   and verifies all owners and non-writable directories immediately before the
   gate and before each of the two recovery invocations; and
8. inventories every reviewed regular file generically, rejects unreviewed
   symlinks, and seals the complete review manifest mode `0400`.

The production gate runs exactly once. Both recovery passes run regardless of
its verdict or exit status. The hosted teardown removes only identities it
recorded and stops on ambiguous cleanup. Before package installation it records
the bounded exact APT simulation closure, each target version, the baseline for
only those package names, and the complete signed PGDG source/key/list metadata
identity. Cleanup removes or restores only that closure. Concurrent changes to
unplanned packages are preserved, while drift of a planned identity is refused;
a retry also accepts each exact recorded baseline. A final independent check
requires no owned path, mount, loop device, identity, package change, image,
container, network, volume, or unit residue.

Before the first hosted bootstrap mutation, preparation creates an
exact-run-bound, root-owned mode-`0700` control root outside both the evidence
and hosted tool roots. Its sole mutable state is a mode-`0600`, file- and
directory-fsynced atomic journal; the evidence directory receives only its
non-writable final copy. Each resource intent is recorded before its effect and
then finalized with the observed identity. The gate itself runs in an exact
transient unit whose journal advances from planned to the exact PID, process
start time, executable, and cgroup, and finally to its exit outcome. Recovery
stops only that revalidated unit identity. It treats an fsynced
interrupted-rename candidate as part of the journal, refuses conflicting
revisions, discards a malformed uncommitted partial only beside a valid primary,
and resumes only uncleaned effects. An exact inactive or failed collected unit
with `MainPID=0` and no marker is recovered as a child that never spawned;
active or identity-ambiguous units remain refused. Missing workload cleanup
documents are accepted only when the journal proves the gate never spawned.

Hosted cleanup first recovers an unfinished gate child and proves absence of
owned processes, units, and containers. It then removes exact images, the full
synthetic passwd/group tuples, the exact XFS mount, loop device, planned package
closure while PGDG metadata remains available, and finally owned paths. True
absence is idempotent only for a journaled identity; changed or multiple
identities are refused. Residue and journal evidence are written before the
control state is atomically moved to a root-owned mode-`0600` cleanup tombstone
outside the control root. The control directory is then removed and parent-
fsynced before the tombstone is unlinked and parent-fsynced. Recovery resumes at
each boundary, while a completed replay is a no-op only after exact cleaned
evidence and current zero residue are both proven. A partial preparation is
never eligible to invoke the production gate and remains safely cleanup-
idempotent after any durable journal boundary.

The evidence directory exists before checkout, dependency installation, or
build. Checkout, input binding, setup, install, and build outcomes are recorded.
Even if one of those early phases fails, an always-run fallback creates the full
required BLOCKED output set, computes `SHA256SUMS` over every evidence, log,
manifest, cleanup, residue, and workflow-status file, seals the directory, and
uploads it before the verdict step fails closed. When root sudo itself is the
failed prerequisite, the fallback seals the runner-owned evidence directly; it
refuses mixed ownership rather than weakening immutability.

Every package includes `hosted-verdict.json`. Its checksummed exact
commit/run/attempt tuple records `BLOCKED`, the first blocked workflow phase,
and a bounded reason on every fallback path, including checkout, toolchain,
install, build, and sudo failures. `PASS` is written only after all workflow
phases and the complete successful evidence path validate, and the final
assertion independently revalidates that verdict.

Evidence remains useful when the gate is `BLOCKED`: the workflow packages gate
and cleanup logs, evidence, the review manifest, cleanup statuses, host
preflight, and residue results; writes `SHA256SUMS`; makes the local package
read-only; and uploads it with the immutable artifact action before enforcing
the final nonzero verdict. Teardown itself exits nonzero when either gate
recovery or hosted cleanup is uncertain. The final assertion independently
requires a tuple-matched hosted `PASS` verdict, a PASS production evidence
schema and every required component PASS, both exact recovery tuples certain,
hosted cleanup certain, zero residue, disabled start flags, and a checksum
inventory covering every packaged file. No credentials or secret contexts are
accepted by the workflow or serialized by the hosted wrapper.

The 300-minute job has an explicit 285-minute worst-case step budget, leaving a
15-minute transition and action-finalization reserve. Every step, including
checkout, toolchain setup, dependency installation, build, preparation,
teardown, residue verification, both sealing paths, upload, and the final
assertion, has its own timeout. The gate receives a 90-minute internal deadline
inside a 95-minute step; each recovery receives a 20-minute internal deadline
inside a 25-minute step. Therefore an internally timed-out gate or first
recovery records a fail-closed outcome before the outer step ends, while the
`always()` recovery, fallback-sealing, and upload chain retains its reserved
budget.
