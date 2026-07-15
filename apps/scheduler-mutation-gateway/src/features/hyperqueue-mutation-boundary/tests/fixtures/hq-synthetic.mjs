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

function repeatedOptions(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined)
      values.push(args[index + 1]);
  }
  return values;
}

if (args.includes("--version")) {
  writeFileSync(1, `hq ${required("--fixture-version")}\n`);
  process.exit(0);
}

const jobIndex = args.indexOf("job");
const submitIndex = args.indexOf("submit");
const workerIndex = args.indexOf("worker");
const fixtureWorkerIndex = args.indexOf("fixture-worker");
const fixtureServerRestartIndex = args.indexOf("fixture-server-restart");

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
  const mappingFingerprint = required("--mapping-fingerprint");
  const jobId = String(state.nextJobId);
  state.nextJobId += 1;
  state.jobs[jobId] = {
    exitCode: null,
    jobId,
    mappingFingerprint,
    shimProtocol: "phase7.scheduler-shim.v1",
    sourceEpoch: state.serverEpoch,
    sourceSequence: 1,
    state: "waiting",
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
  save(state);
  if (option("--fixture-mode") === "malformed_submit") {
    writeFileSync(1, "{malformed-json");
    process.exit(0);
  }
  if (option("--fixture-mode") === "partition_after_submit") {
    writeFileSync(2, "synthetic partition after submit\n");
    process.exit(70);
  }
  output({ id: Number(jobId) });
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
      id: Number(jobId),
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
