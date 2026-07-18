#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function required(name) {
  const value = option(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
}

function statePath() {
  return join(required("--server-dir"), "scheduler.json");
}

function load() {
  return JSON.parse(readFileSync(statePath(), "utf8"));
}

function save(state) {
  writeFileSync(statePath(), `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function output(value) {
  writeFileSync(1, JSON.stringify(value));
}

function jobListTaskStats(state) {
  const taskStats = {
    aborted: 0,
    canceled: 0,
    failed: 0,
    finished: 0,
    running: 0,
    waiting: 0,
  };
  const normalized =
    state === "unknown" || state === "lost" ? "waiting" : state;
  if (Object.hasOwn(taskStats, normalized)) taskStats[normalized] = 1;
  else throw new Error("unsupported synthetic job-list state");
  return taskStats;
}

function repeatedOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined)
      values.push(args[index + 1]);
  }
  return values;
}

if (args.includes("--version")) {
  writeFileSync(1, `hyperqueue v${required("--fixture-version")}\n`);
  process.exit(0);
}

const jobIndex = args.indexOf("job");
const submitIndex = args.indexOf("submit");
const workerIndex = args.indexOf("worker");
const fixtureWorkerIndex = args.indexOf("fixture-worker");
const fixtureServerRestartIndex = args.indexOf("fixture-server-restart");
const fixtureJournalRestartIndex = args.indexOf("fixture-journal-restart");
const fixtureConflictingSubmitIndex = args.indexOf(
  "fixture-conflicting-next-submit",
);
const fixtureMode = option("--fixture-mode");

if (fixtureServerRestartIndex >= 0) {
  const state = load();
  const restartPoint = args[fixtureServerRestartIndex + 1];
  state.serverEpoch += 1;
  state.workerSequence += 1;
  for (const job of Object.values(state.jobs)) {
    job.sourceEpoch = state.serverEpoch;
    job.sourceSequence = 1;
    if (restartPoint === "before_flush") {
      job.exitCode = null;
      job.state = "unknown";
      job.workerId = null;
    } else if (restartPoint !== "after_flush") {
      throw new Error("unsupported synthetic server restart point");
    }
  }
  save(state);
  process.exit(0);
}

if (fixtureJournalRestartIndex >= 0) {
  const state = load();
  const restartPoint = args[fixtureJournalRestartIndex + 1];
  if (restartPoint !== "lost_unflushed")
    throw new Error("unsupported synthetic journal restart point");
  state.serverEpoch += 1;
  state.workerSequence += 1;
  state.jobs = {};
  state.submissions = {};
  save(state);
  process.exit(0);
}

if (fixtureConflictingSubmitIndex >= 0) {
  const state = load();
  state.conflictingNextSubmit = true;
  save(state);
  process.exit(0);
}

if (fixtureWorkerIndex >= 0) {
  const state = load();
  const jobId = args[fixtureWorkerIndex + 1];
  const nextState = args[fixtureWorkerIndex + 2];
  const job = state.jobs[jobId];
  if (job === undefined) throw new Error("job absent");
  job.state = nextState;
  job.sourceSequence += 1;
  job.workerId = nextState === "lost" ? null : "worker-1";
  if (nextState === "finished") job.exitCode = 0;
  if (nextState === "failed") job.exitCode = 1;
  save(state);
  process.exit(0);
}

if (submitIndex >= 0) {
  const state = load();
  state.mutationCalls += 1;
  if (fixtureMode === "ambiguous_zero") {
    save(state);
    writeFileSync(2, "synthetic partition before submit\n");
    process.exit(70);
  }
  const mappingFingerprint = required("--mapping-fingerprint");
  const jobName = required("--name");
  const jobId = String(state.nextJobId);
  state.nextJobId += 1;
  state.jobs[jobId] = {
    exitCode: null,
    jobId,
    name: jobName,
    mappingFingerprint,
    shimProtocol: "phase7.scheduler-shim.v1",
    sourceEpoch: state.serverEpoch,
    sourceSequence: 1,
    state:
      fixtureMode === "ambiguous_running"
        ? "running"
        : fixtureMode === "ambiguous_finished"
          ? "finished"
          : fixtureMode === "ambiguous_canceled"
            ? "canceled"
            : "waiting",
    taskId: "0",
    workerId: null,
  };
  const resources = {};
  for (const resource of repeatedOptions("--resource")) {
    const [name, encodedAmount] = resource.split("=");
    resources[name] = Number(encodedAmount);
  }
  state.submissions[jobId] = {
    requestedCpuCount: Number(required("--cpus")),
    requiredCustomResources: resources,
    restartPolicy: required("--restart-policy"),
  };
  if (fixtureMode === "ambiguous_duplicate") {
    const duplicateId = String(state.nextJobId);
    state.nextJobId += 1;
    state.jobs[duplicateId] = {
      ...state.jobs[jobId],
      jobId: duplicateId,
      sourceSequence: 2,
    };
    state.submissions[duplicateId] = { ...state.submissions[jobId] };
  }
  save(state);
  if (fixtureMode === "malformed_submit") {
    writeFileSync(1, "{malformed-json");
    process.exit(0);
  }
  if (state.conflictingNextSubmit) {
    state.conflictingNextSubmit = false;
    save(state);
    output({ id: 1 });
    process.exit(0);
  }
  if (
    fixtureMode === "partition_after_submit" ||
    fixtureMode === "ambiguous_duplicate" ||
    fixtureMode === "ambiguous_malformed_lookup" ||
    fixtureMode === "ambiguous_oversized_lookup" ||
    fixtureMode === "ambiguous_incomplete_lookup" ||
    fixtureMode === "ambiguous_running" ||
    fixtureMode === "ambiguous_finished" ||
    fixtureMode === "ambiguous_canceled"
  ) {
    writeFileSync(2, "synthetic partition after submit\n");
    process.exit(70);
  }
  output({ id: Number(jobId) });
  process.exit(0);
}

if (jobIndex >= 0 && args[jobIndex + 1] === "list") {
  const state = load();
  state.lookupCalls += 1;
  save(state);
  if (fixtureMode === "ambiguous_malformed_lookup" && state.mutationCalls > 0) {
    writeFileSync(1, "{malformed-json");
    process.exit(0);
  }
  if (fixtureMode === "ambiguous_oversized_lookup" && state.mutationCalls > 0) {
    writeFileSync(1, "x".repeat(256 * 1024));
    process.exit(0);
  }
  output(
    Object.values(state.jobs).map((job) =>
      fixtureMode === "ambiguous_incomplete_lookup"
        ? {
            cancel_reason:
              job.state === "canceled" ? "canceled by fixture" : null,
            id: Number(job.jobId),
            is_open: false,
            name: job.name,
            task_count: 1,
            // task_stats is deliberately absent in this fail-closed fixture.
          }
        : {
            cancel_reason:
              job.state === "canceled" ? "canceled by fixture" : null,
            id: Number(job.jobId),
            is_open: false,
            name: job.name,
            task_count: 1,
            task_stats: jobListTaskStats(job.state),
          },
    ),
  );
  process.exit(0);
}

if (jobIndex >= 0 && args[jobIndex + 1] === "cancel") {
  const state = load();
  state.mutationCalls += 1;
  const jobId = args[jobIndex + 2];
  const job = state.jobs[jobId];
  if (job === undefined) throw new Error("job absent");
  job.state = "canceled";
  job.sourceSequence += 1;
  save(state);
  output({});
  process.exit(0);
}

if (jobIndex >= 0 && args[jobIndex + 1] === "info") {
  const state = load();
  const jobId = args[jobIndex + 2];
  const job = state.jobs[jobId];
  if (job === undefined) throw new Error("job absent");
  output([
    {
      info: { id: Number(jobId) },
      tasks: [
        {
          exit_code: job.exitCode,
          id: Number(job.taskId),
          state: job.state,
          worker_id: job.workerId,
        },
      ],
    },
  ]);
  process.exit(0);
}

if (workerIndex >= 0 && args[workerIndex + 1] === "list") {
  const state = load();
  output(
    state.workers.map((worker) => ({
      id: worker.workerId,
      resources: worker.customResources,
      state: worker.state,
    })),
  );
  process.exit(0);
}

throw new Error("unsupported synthetic hq command");
