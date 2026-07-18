# Disposable-host production-readiness gate

This manual gate collects real compatibility and safety evidence without
enabling production. It is never run by `pnpm test`, `pnpm check`, or a normal
build. Run it only through the hosted orchestrator on a reviewed disposable
Linux host with no user projects, unrelated workloads, or shared services.

The evidence schema is
`workload-funnel.production-readiness-gate.v1`, defined in
`disposable-host-production-readiness-gate.schema.json`. Every verdict keeps
`productionStartsEnabled` and `privilegedStartsEnabled` false.

## Admission and reviewed-byte binding

The gate requires all of the following before its first host-side effect:

- effective UID 0 and the exact disposable-host attestation in both argv and
  `WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION`;
- a fresh root-owned mode-0700 sandbox exactly at
  `/var/data/workload-funnel/sandboxes/$RUN_ID`;
- operation `run`, or operation `recover-cleanup` against an existing sandbox;
- a canonical root-owned, non-writable review manifest and its SHA-256 in both
  argv and `WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256`;
- an exact manifest inventory of every regular repository file after build and
  the HyperQueue archive, excluding only VCS/session, dependency, coverage, and
  cache directories, with no reviewed-tree symlinks;
- architecture-plan SHA-256
  `73dffc99721b929e1e2b109d62f38263f433adb9534bb5fa545978a8c851ccdf`;
- canonical root-owned executable files and ancestor directories, no writable
  executable, exact mode and SHA-256, and identity revalidation before every
  spawn;
- root-owned, non-writable workspace-resolution directories and exact symlinks
  from the reviewed systemd adapter to its reviewed runtime dependencies;
- the exact Postgres, MinIO, and MinIO Client image references; and
- the target architecture, kernel release, machine-ID hash, and boot-ID hash.

The root-owned review manifest uses schema
`workload-funnel.production-gate.review-manifest.v1` and has exactly these
top-level fields:

```json
{
  "schemaVersion": "workload-funnel.production-gate.review-manifest.v1",
  "reviewId": "review-system-identifier",
  "sourceTreeDigest": "sha256:<digest-of-sorted-path-null-sha256-lines>",
  "host": {
    "architecture": "x64",
    "kernelRelease": "<exact uname release>",
    "machineIdSha256": "<64 lowercase hex>",
    "bootIdSha256": "<64 lowercase hex>"
  },
  "images": {
    "azuriteFixture": "<exact accepted reference>",
    "postgresFixture": "<exact accepted reference>",
    "objectFixture": "<exact accepted reference>",
    "objectClient": "<exact reviewed reference with sha256 digest>"
  },
  "executables": [
    {
      "path": "/canonical/executable",
      "uid": 0,
      "gid": 0,
      "mode": 493,
      "sha256": "<64 lowercase hex>"
    }
  ],
  "reviewedFiles": [
    { "path": "/absolute/reviewed/file", "sha256": "<64 lowercase hex>" }
  ]
}
```

The hosted orchestrator generates this manifest after the exact build and
review, installs it as root, and supplies its out-of-band digest. A reboot,
file drift, executable replacement, omitted file, extra file, image drift, or
host mismatch refuses admission.

## Host prerequisites

- x86-64 architecture, unified cgroup v2, systemd 250 or newer, Docker, the AWS
  CLI, PostgreSQL 18 client, and `systemd-analyze`;
- a pre-created `workload-funnel-synthetic` non-root user and group;
- root-owned search-only mode-`0711`
  `/var/lib/workload-funnel/allocations` and private mode-`0700`
  `/var/lib/workload-funnel/project-quota` directories on the same reviewed
  XFS (`prjquota` or `pquota`) or ext4 (`prjquota`) project-quota filesystem;
  each unguessable per-run allocation remains synthetic-owned mode-`0700`, and
  `/var/data/workload-funnel/sandboxes` remains root-owned;
- enough unused CPU, memory, IO, PID, byte, and inode headroom;
- the reviewed HyperQueue 0.26.2 x64 archive with SHA-256
  `e15dae9113e1a307a97a66bfe90f74f78c6016239436b5d9f1e4efec480e84b5`;
- locally pre-pulled immutable images. The accepted fixture pins are
  `postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15`
  and
  `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2`.
  MinIO Client must be an exact reviewed release plus digest in the manifest.

The IO device is a disposable data device used only for declared Docker and
systemd bandwidth controls. The gate never writes cgroupfs or changes firewall
or host routes.

## Hosted invocation

Build first. The review manifest must describe the resulting exact tree.

```bash
pnpm build
export RUN_ID=wf-production-gate-0123456789abcdef0123456789abcdef
export SANDBOX=/var/data/workload-funnel/sandboxes/$RUN_ID
export WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION=I_ATTEST_THIS_IS_A_DISPOSABLE_HOST_WITH_NO_USER_PROJECTS
export WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256='<64 lowercase hex>'
pnpm production-gate:host -- \
  --operation run \
  --attestation "$WF_PRODUCTION_GATE_DISPOSABLE_HOST_ATTESTATION" \
  --review-manifest /root/workload-funnel-production-gate-review.json \
  --review-manifest-sha256 "$WF_PRODUCTION_GATE_REVIEW_MANIFEST_SHA256" \
  --run-id "$RUN_ID" \
  --sandbox-root "$SANDBOX" \
  --evidence-path "$SANDBOX/evidence.json" \
  --docker-executable /usr/bin/docker \
  --psql-executable /usr/bin/psql \
  --project-quota-helper /usr/libexec/workload-funnel/linux-project-quota \
  --aws-executable /usr/bin/aws \
  --id-executable /usr/bin/id \
  --node-executable /canonical/path/to/node \
  --systemctl-executable /usr/bin/systemctl \
  --systemd-analyze-executable /usr/bin/systemd-analyze \
  --systemd-run-executable /usr/bin/systemd-run \
  --io-device /dev/DISPOSABLE_DEVICE \
  --hq-archive /opt/wf-fixtures/hq-v0.26.2-linux-x64.tar.gz \
  --hq-binary /opt/wf-fixtures/hq \
  --azurite-image 'mcr.microsoft.com/azure-storage/azurite:3.35.0@sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37' \
  --postgres-image 'postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15' \
  --object-image 'quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:a1a8bd4ac40ad7881a245bab97323e18f971e4d4cba2c2007ec1bedd21cbaba2' \
  --object-client-image "$REVIEWED_MINIO_CLIENT_IMAGE"
```

After an interrupted run, invoke the same reviewed inputs with
`--operation recover-cleanup`. Recovery writes `cleanup-recovery.json`, keeps
uncertain records durable, and exits nonzero until every exact owned resource
is removed.

## Isolation, secrecy, and cleanup

All commands receive a fixed minimal replacement environment. Host processes
run as `workload-funnel-synthetic` in transient services with empty ambient and
bounding capabilities, private network/device/tmp namespaces, closed device
policy, read-only host filesystem except the run allocation, seccomp filtering,
full-tree kill, and CPU, memory, swap, PID, file-size, runtime, and IO bounds.

Docker uses an internal bridge with no host port publication, read-only
filesystems, private IPC/UTS, init, no-new-privileges, all
capabilities dropped, non-root users, exact platform, `--pull=never`, and
fixed CPU, memory, swap, PID, file-size, file-descriptor, IO, command, and data
budgets. Object data uses bounded tmpfs. Reviewed, read-only-mounted supervisors
restart only the MinIO or Azurite server process, leaving each owned container
and its data tmpfs alive. The gate requires a stable container/supervisor
boundary, a new server generation and PID, renewed readiness, unchanged
confinement, and the same server checksum. Azurite's supervisor reads its
generated fixture account key from a mode-0400 bind-mounted file and passes it
only to the container-local server process environment; neither the key nor any
SAS is written to Docker configuration, process arguments, or evidence. The
fixture keeps server API-version validation enabled and pins the client request
version. PostgreSQL uses an
exact-identity,
mode-0700 bind directory under the fixed sandbox so WAL recovery survives a
forced server-process stop. Its image-declared `/var/lib/postgresql` parent
remains an exact 64 MiB mode-0700 tmpfs around the nested durable data bind, and
`/var/run/postgresql` is a separate exact 1 MiB mode-0700 tmpfs used as the
explicit Unix-socket directory. Its fixed probe SQL, connection count,
statement timeouts, temporary-file limit, and WAL targets bound the fixture workload.
The directory is prepared and fsynced in the cleanup ledger before creation and
is removed only after its container. Before the host contacts either fixture,
the gate requires the exact internal network to be the container's only network,
proves that network is an internal bridge, rejects every requested or assigned
published port, and matches one canonical Docker-assigned IPv4 endpoint to the
container's membership and the network's sole IPv4 subnet. Missing, malformed,
multiple, or foreign network/IP evidence fails closed. The probes then connect
directly to that validated internal-container address. Secrets are mode-0400
bind-mounted files.
Docker's persistent `Config.Env` and `Config.Cmd` metadata contains only
non-secret values and secret-file paths. MinIO user credentials are streamed
from the mounted file to `mc` stdin; `mc` argv contains only the non-secret
alias, policy, and deterministic user identifier.

The cleanup ledger persists and fsyncs intent before each effect, finalizes the
exact observed identity, atomically replaces and directory-fsyncs each record,
reopens and checksum-validates state, and cleans in reverse order. Prepared and
uncertain records survive crashes. Recovery removes only a matching label,
invocation, inode, digest, or other recorded identity; ambiguity remains
BLOCKED.

## Truthful verdicts

- `PASS` requires only real evidence for that component.
- `BLOCKED` means a required behavior, adapter, provider property, or cleanup
  result was not proven.
- `UNSUPPORTED` means an actual non-mutating host capability probe found that
  the host cannot safely run the component.

Current repository closure is intentionally fail-closed:

- the Postgres 18.4 fixture proves duplicate acceptance and synchronized
  pre-commit rollback plus post-commit persistence across `SIGKILL` of the
  container process boundary and PostgreSQL WAL recovery from durable
  sandbox-owned storage. The same disposable fixture runs the real
  `pg@8.22.0` asynchronous lifecycle adapter through concurrent migration,
  duplicate/conflicting acceptance, exact lookup, optimistic conflict,
  rollback, pre-/post-commit connection loss, reopen, migration corruption,
  pool exhaustion/timeout, abort, and credential-redaction probes;
- the MinIO fixture preserves its checksum across an evidenced server-process
  restart inside the stable container/tmpfs boundary and proves network recovery
  plus disjoint upload, verify, and delete identities. The upload policy grants
  only `s3:PutObject` on one exact key, and the adapter sends
  `If-None-Match: *`, but the credential itself is not create-only. Exact probes
  against the pinned MinIO KVM fixture found `s3:if-none-match`,
  `x-amz-content-sha256`, and `ExistingObjectTag` conditions unsupported for
  `PutObject`. An unconditional PUT of distinct bytes to the same key with the
  same upload credential succeeds and changes the server checksum. This is a
  passing negative compatibility proof, not production-provider evidence.
  MinIO remains compatibility-only and is not an approved production provider;
- the Azure Blob production adapter uses exact-resource blob SAS credentials:
  upload gets only `sp=c,sr=b`, verification gets a separate `sp=r,sr=b`
  credential, direct upload is single-request, `If-None-Match: *` is
  defense-in-depth, Content-MD5 is server-validated, and immutable
  `wfsha256` metadata is reconciled before an ambiguous outcome is accepted as
  idempotent. The pinned Azurite fixture proves that the create credential
  cannot overwrite, read, list, delete, mutate metadata, stage blocks, or reach
  another blob; stale and write-capable SAS policies fail before network IO.
  It also proves exact state across a server-process restart in a stable
  container/tmpfs boundary. Azurite exercises the official Azure API permission
  contract but is explicitly not claimed as full Azure cloud parity;
- HyperQueue 0.26.2 uses restart-durable fsynced gateway intent and create-only
  mapping ordering, a gateway-derived bounded non-secret digest name over the
  complete persisted submit intent, exact pinned job-list rows, and exact
  post-cancel observation. The digest has fail-closed collision handling and is
  not claimed mathematically injective. The gate performs one real submit,
  deliberately loses its response only after the actual built
  `HyperQueueMutationBoundary` submit runner returns. It restarts the built
  `SchedulerMutationGatewayClient` composition on the same fsynced WAL/mapping
  state, resolves and replays the durable receipt through the public gateway
  API, restarts the server on the same journal, and proves the same retained job,
  the configured history ceiling, stable WAL on retry, and exactly one submit.
  Its post-restart lookup evidence is `retainedExactJobMatches=1`: exact retained
  name, job ID, count, and schema, without claiming that lookup re-proves the
  canceled task state.
  The response-loss path cannot be replaced by a standalone lookup probe.
  Invalid output fails closed, zero is never absence, and no unresolved name is
  eligible for pruning or forgetting. Gateway WAL v1 is intentionally
  migration-blocked; only v2 carries this contract. The schema remains the
  exact HyperQueue 0.26.2 evidence from upstream commit `dd15afd`. The repository
  capability booleans stay false until that disposable evidence is reviewed.
  Cancellation of an ambiguous live submit without one exact mapping remains
  unproved and is a separate blocker.
  The adapter does not claim native submit idempotency or exactly-once
  execution. Broader HyperQueue production approval remains closed by the
  separately reported pin, worker restart, process ownership, isolation,
  security, fallback, and upstream-risk decisions;
- the running systemd manager, cgroup controllers, and required unit properties
  are probed with read-only `systemctl` plus non-mutating `systemd-analyze
verify`. The reviewed native helper then applies and reads back exact byte and
  inode project quotas on only the gate-owned allocation, persists and reopens
  its fsync-durable receipt, and registers exact reverse-order cleanup. A host
  without supported XFS/ext4 project quotas remains `UNSUPPORTED`; pinned
  execution-path capability remains absent; and
- pressure evidence requires bounded CPU, memory, IO, disk-byte, and inode load,
  pause, protected cancel/status/health service responsiveness, hysteretic
  reopen, at least 10 seconds, at least 100 samples, and all p99 SLOs.

Any blocker makes the overall verdict non-PASS. The command exits 0 only for an
overall PASS, 1 for completed BLOCKED/UNSUPPORTED evidence, and 2 for admission
refusal.
