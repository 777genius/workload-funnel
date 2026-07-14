# Hosted subscription-runtime canary

## Scope

This is a canary-only acceptance check between the node-owned WorkloadFunnel
bridge and one allowlisted `subscription-runtime-codex-goal` release. It does
not enable production starts or prove Postgres, systemd/cgroup, object-store,
network-service, HyperQueue, or general provider reliability. The control
service is not in this launch path.

The inspected deployed release exposes `codex_goal_start` as a detached tmux
launcher. That tool and every other mutation tool are forbidden here. The
adapter starts exactly one direct foreground child with `run --no-tmux` and a
complete argv. It uses no shell, tmux command, daemon, systemd, D-Bus, Docker
socket, network service, or HyperQueue. The outer node process owns termination
and foreground completion evidence.

The adapter captures no foreground stdout or stderr because provider output can
contain secrets. It does not open, copy, hash, enumerate, or serialize any file
below the runtime auth root. Evidence and WorkloadFunnel WALs contain neither
auth paths nor account selectors. The evidence describes only harness behavior;
it does not trace runtime syscalls or provider traffic. Natural-completion mode
reads only the bounded strict runtime result and the one expected harmless
workspace artifact. It does not copy runtime-result evidence strings into the
canary evidence.

Run this only on the designated canary host and only against a new disposable
git project. Never point it at a user or production project.

## Reviewed deployed contract

On 2026-07-14, the read-only `--help` and `tools` interfaces of
`/usr/local/bin/subscription-runtime-codex-goal` produced these SHA-256 values:

- executable wrapper: `00291604d20c7a3afa156ab73a1bef1e6d1410013c6e63dda30e213c8a6a4fa6`
- root help: `8e25087c6b0d843226c68e194f9a784bda4ec9782b56a6d3eada36501d957f84`
- tools catalog: `d82ba840705e54f194fe4c49bb17fadb57d6e4f121c8e14f89ac46c698e8a05e`

The tools catalog describes `codex_goal_start` as starting a detached tmux
worker. Its JSON schema uses camelCase fields including `jobId`, `jobRootDir`,
`authRootDir`, `workspacePath`, `promptPath`, `taskId`, `outputPath`,
`progressPath`, `reasoningEffort`, `serviceTier`, `accessBoundary`, and
`projectAccessScope`. Snake-case forms such as `job_id` are not this contract.

The canary still probes and pins all three hashes immediately before any live
disposable run. Any difference fails closed and requires a new review.

## Prepare the disposable project

Create a mode `0700` directory directly beneath a dedicated sandbox parent. Its
basename must begin with `workload-funnel-disposable-canary-`. Initialize a new
git repository with no history and no remotes. The root may contain only
`.git`, the sentinel, request, prompt, and harness-created
`.workload-funnel-canary` directory. The local git config may contain only
inert `core` settings emitted by a fresh `git init`; command-bearing settings
such as `core.fsmonitor` fail closed.

Create `.workload-funnel-disposable-canary.json` with mode `0600`:

```json
{
  "createdAtMs": 1784026800000,
  "disposable": true,
  "nonce": "replace-with-at-least-32-fresh-lowercase-hex-characters",
  "productionStartsEnabled": false,
  "purpose": "WORKLOAD_FUNNEL_SUBSCRIPTION_RUNTIME_DISPOSABLE_CANARY_ONLY",
  "schemaVersion": 1
}
```

Use current epoch milliseconds; the sentinel expires after one hour. Create
`hosted-canary-prompt.md` with mode `0600` and exactly this content:

```text
WORKLOAD_FUNNEL_HOSTED_CANARY_ONLY

Create exactly one new file named hosted-canary-result.txt in the workspace root.
Its complete contents must be exactly this single line:
WORKLOAD_FUNNEL_HOSTED_CANARY_COMPLETED
Do not modify or create any other workspace file. Do not run git add, git commit, or git push.
Finish after writing the file.
```

Create `hosted-canary-request.json` with mode `0600`. It carries only the
opaque trusted invocation-profile identity, fixed prompt path, and task ID. It
must not carry an auth root, account selector, token, credential, model, or
access policy.

```json
{
  "invocationProfileId": "hosted-canary-profile",
  "promptPath": "/var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001/hosted-canary-prompt.md",
  "schemaVersion": 1,
  "taskId": "workload-funnel-hosted-canary-task"
}
```

## Install the trusted invocation profile

The host operator owns a mode `0600` profile outside the disposable project.
The file contains selectors and policy, never credential bytes. The referenced
auth root remains owned and interpreted by `subscription-runtime`; the canary
adapter only passes its path and the selected account names as required argv.

```json
{
  "accessBoundary": "isolated_workspace_write",
  "accountSelectors": ["canary-account-a"],
  "authRoot": "/var/lib/subscription-runtime/auth",
  "executionEngine": "app-server-goal",
  "model": "gpt-5.5",
  "networkAccess": "restricted",
  "profileId": "hosted-canary-profile",
  "profileRevision": "revision-1",
  "reasoningEffort": "high",
  "schemaVersion": 1,
  "serviceTier": "default"
}
```

The trusted adapter fails closed when the profile is missing, unsafe,
malformed, mismatched, or placed inside the disposable project. It never falls
back to inherited auth or account environment variables.

## Probe and pin the release

Build the integrated WorkloadFunnel tree, then run the non-mutating probe. It
invokes only root `--help` and `tools` against the disposable project.

```text
pnpm canary:hosted -- probe \
  --sandbox-parent /var/tmp/workload-funnel-canaries \
  --project-root /var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001 \
  --request /var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001/hosted-canary-request.json \
  --runtime-binary /usr/local/bin/subscription-runtime-codex-goal
```

Review `binarySha256`, `cliHelpSha256`, and `toolsCatalogSha256` from the JSON
output. The probe validates the required foreground help, the tmux-owning start
tool description, and camelCase tool schema before emitting those hashes.

## Run the live disposable canary

Live mode requires both exact opt-ins and the host-owned profile. Use the hashes
from the immediately preceding reviewed probe:

```text
WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE=1 pnpm canary:hosted -- live \
  --sandbox-parent /var/tmp/workload-funnel-canaries \
  --project-root /var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001 \
  --request /var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001/hosted-canary-request.json \
  --runtime-binary /usr/local/bin/subscription-runtime-codex-goal \
  --invocation-profile /etc/workload-funnel/hosted-canary-profile.json \
  --expected-runtime-sha256 REPLACE_WITH_PROBED_BINARY_SHA256 \
  --expected-cli-help-sha256 REPLACE_WITH_PROBED_CLI_HELP_SHA256 \
  --expected-tools-catalog-sha256 REPLACE_WITH_PROBED_TOOLS_CATALOG_SHA256 \
  --evidence /var/tmp/workload-funnel-canaries/workload-funnel-disposable-canary-001/.workload-funnel-canary/state/hosted-canary-evidence.json \
  --live-opt-in WORKLOAD_FUNNEL_DISPOSABLE_CANARY_LIVE \
  --scenario natural_completion
```

The direct foreground argv contains `run --no-tmux`, job root, auth root,
workspace, prompt, task ID, accounts, registry root, output, progress, model,
effort, service tier, execution engine, isolated-workspace access boundary,
project access scope JSON, and restricted network policy. It contains no shell
command or runtime mutation tool.

`natural_completion` is the primary acceptance scenario. It waits up to the
bounded foreground timeout for the direct child to exit on its own. Passing
requires exit code zero and the deployed strict result contract: schema version
1, provider `codex`, matching run/task IDs, status `done`, next action
`review_completed`, no blockers, and exactly one changed path,
`hosted-canary-result.txt`. The project is then checked independently: the
artifact must be a regular owner-controlled file containing exactly
`WORKLOAD_FUNNEL_HOSTED_CANARY_COMPLETED` plus one newline, the prompt, request,
sentinel, and fresh no-history git metadata must be unchanged, and no unexpected
root path may exist. Timeout, missing or contradictory result, unexpected paths,
or a missing/incorrect artifact produces `unknown` and never `passed`.

## Run the separate forced-stop scenario

Use a second fresh disposable project, request, task ID, and evidence path. Run
the same command with `--scenario forced_stop`. This secondary scenario waits a
short bounded observation window and then exercises the fenced outer stop. Its
passing evidence has `completionMode: forced_stop`, no terminal-result or
artifact claim, `outerTermination: completed`, and a signal-style null exit
code. It does not replace the required natural-completion scenario.

An `unknown` result is not permission to retry. Preserve the disposable sandbox
and operation WAL for reconciliation. A reserved or ambiguous foreground start
is never automatically replayed; stale and equal-version-mismatched authority
also fails closed.

Validate evidence against
`docs/operations/hosted-subscription-runtime-canary-evidence.schema.json`. A
passing natural-completion result proves only the pinned read-only CLI/tool
contract, one bounded argv-only foreground child, successful strict terminal
status, and the exact disposable artifact. A passing forced-stop result proves
only the same launch ownership plus observed outer termination. Neither enables
production or proves the unavailable production dependencies listed above.
