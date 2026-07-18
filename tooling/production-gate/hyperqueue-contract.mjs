import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { gunzipSync } from "node:zlib";

import {
  HYPERQUEUE_VERSION,
  HYPERQUEUE_X64_ARCHIVE_SHA256,
  OWNED_RESOURCE_PATTERN,
} from "./constants.mjs";

export function officialHyperQueueSubmitArguments(input) {
  if (
    !(
      OWNED_RESOURCE_PATTERN.test(input.jobName) ||
      /^wf-hq-v1-[A-Za-z0-9_-]{86}$/u.test(input.jobName)
    ) ||
    !Number.isSafeInteger(input.cpus) ||
    input.cpus < 1 ||
    input.cpus > 64 ||
    !input.shimExecutable.startsWith("/") ||
    !input.serverDirectory.startsWith("/") ||
    input.serverDirectory.includes("\u0000") ||
    !Array.isArray(input.shimArguments) ||
    input.shimArguments.some(
      (argument) => typeof argument !== "string" || argument.includes("\u0000"),
    )
  )
    throw new Error("unsafe_hyperqueue_gate_submission");
  return Object.freeze([
    "--server-dir",
    input.serverDirectory,
    "submit",
    "--output-mode",
    "json",
    "--name",
    input.jobName,
    "--max-fails",
    "0",
    "--cpus",
    String(input.cpus),
    "--",
    input.shimExecutable,
    ...input.shimArguments,
  ]);
}

export function parseOfficialSubmit(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("hyperqueue_submit_json_malformed");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join() !== "id" ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0
  )
    throw new Error("hyperqueue_submit_schema_invalid");
  return Object.freeze({ jobId: String(value.id), taskId: "0" });
}

export function officialHyperQueueCancelArguments(serverDirectory, jobId) {
  if (
    !serverDirectory.startsWith("/") ||
    serverDirectory.includes("\u0000") ||
    !/^(?:0|[1-9]\d*)$/u.test(jobId)
  )
    throw new Error("hyperqueue_job_id_invalid");
  return Object.freeze([
    "--server-dir",
    serverDirectory,
    "job",
    "cancel",
    jobId,
    "--output-mode",
    "json",
  ]);
}

export function parseOfficialCancel(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("hyperqueue_cancel_json_malformed");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  )
    throw new Error("hyperqueue_cancel_schema_invalid");
  return Object.freeze({ acknowledged: true });
}

export function parseOfficialArray(output, kind) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`hyperqueue_${kind}_json_malformed`);
  }
  if (!Array.isArray(value))
    throw new Error(`hyperqueue_${kind}_schema_invalid`);
  return Object.freeze(value);
}

function canonicalOfficialJobId(value) {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value))
    throw new Error("hyperqueue_job_info_schema_invalid");
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric))
    throw new Error("hyperqueue_job_info_schema_invalid");
  return value;
}

export function parseOfficialJobInfo(output, expectedJobId) {
  const jobs = parseOfficialArray(output, "job_info");
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    job === null ||
    typeof job !== "object" ||
    Array.isArray(job) ||
    Object.hasOwn(job, "id") ||
    job.info === null ||
    typeof job.info !== "object" ||
    Array.isArray(job.info) ||
    !Object.hasOwn(job.info, "id") ||
    !Array.isArray(job.tasks)
  )
    throw new Error("hyperqueue_job_info_schema_invalid");
  const jobId = canonicalOfficialJobId(job.info.id);
  if (jobId !== canonicalOfficialJobId(expectedJobId))
    throw new Error("hyperqueue_job_info_identity_mismatch");
  const taskIds = job.tasks.map((task) => {
    if (task === null || typeof task !== "object" || Array.isArray(task))
      throw new Error("hyperqueue_job_info_schema_invalid");
    return canonicalOfficialJobId(task.id);
  });
  if (new Set(taskIds).size !== taskIds.length)
    throw new Error("hyperqueue_job_info_schema_invalid");
  return Object.freeze({ job, jobId });
}

function pinnedArchiveBinary(archive) {
  let tar;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new Error("hyperqueue_archive_format_unsupported");
  }
  const matches = [];
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const string = (start, end) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/u, "");
    const name = string(0, 100);
    const type = string(156, 157);
    const encodedSize = string(124, 136).trim();
    if (!/^[0-7]+$/u.test(encodedSize))
      throw new Error("hyperqueue_archive_entry_invalid");
    const size = Number.parseInt(encodedSize, 8);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (!Number.isSafeInteger(size) || size < 0 || bodyEnd > tar.byteLength)
      throw new Error("hyperqueue_archive_entry_invalid");
    if ((type === "" || type === "0") && basename(name) === "hq")
      matches.push(tar.subarray(bodyStart, bodyEnd));
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (matches.length !== 1 || matches[0].byteLength === 0)
    throw new Error("hyperqueue_archive_binary_not_unique");
  return matches[0];
}

export function exactOfficialHyperQueueVersion(result) {
  return officialHyperQueueVersionFailure(result) === undefined;
}

export function officialHyperQueueVersionFailure(result) {
  if (result.code !== 0 || result.errorCode !== undefined)
    return "hyperqueue_version_command_failed";
  if (result.stderr.length !== 0) return "hyperqueue_version_stderr_unexpected";
  if (result.stdout !== `hyperqueue v${HYPERQUEUE_VERSION}\n`)
    return "hyperqueue_exact_version_mismatch";
  return undefined;
}

export async function verifyHyperQueueRelease({
  archivePath,
  binaryPath,
  runner,
}) {
  const [archiveIdentity, binaryIdentity] = await Promise.all([
    lstat(archivePath),
    lstat(binaryPath),
  ]);
  if (
    (await realpath(archivePath)) !== archivePath ||
    (await realpath(binaryPath)) !== binaryPath ||
    !archiveIdentity.isFile() ||
    archiveIdentity.uid !== 0 ||
    archiveIdentity.gid !== 0 ||
    archiveIdentity.size < 1 ||
    archiveIdentity.size > 256 * 1024 * 1024 ||
    (archiveIdentity.mode & 0o022) !== 0 ||
    !binaryIdentity.isFile() ||
    binaryIdentity.uid !== 0 ||
    binaryIdentity.gid !== 0 ||
    binaryIdentity.size < 1 ||
    binaryIdentity.size > 64 * 1024 * 1024 ||
    (binaryIdentity.mode & 0o022) !== 0
  )
    throw new Error("hyperqueue_release_file_identity_untrusted");
  const archive = await readFile(archivePath);
  const archiveSha256 = createHash("sha256").update(archive).digest("hex");
  if (archiveSha256 !== HYPERQUEUE_X64_ARCHIVE_SHA256)
    throw new Error("hyperqueue_archive_checksum_mismatch");
  const binary = await readFile(binaryPath);
  const archiveBinarySha256 = createHash("sha256")
    .update(pinnedArchiveBinary(archive))
    .digest("hex");
  const binarySha256 = createHash("sha256").update(binary).digest("hex");
  if (binarySha256 !== archiveBinarySha256)
    throw new Error("hyperqueue_binary_not_from_pinned_archive");
  const version = await runner.run(binaryPath, ["--version"], {
    timeoutMs: 5_000,
  });
  const versionFailure = officialHyperQueueVersionFailure(version);
  if (versionFailure !== undefined) throw new Error(versionFailure);
  return Object.freeze({
    archiveSha256,
    binarySha256,
    version: HYPERQUEUE_VERSION,
  });
}

function successful(result, code) {
  if (result.code !== 0) throw new Error(code);
  return result.stdout;
}

async function poll(config, operation, code) {
  const deadline = config.clock() + 8_000;
  for (;;) {
    const result = await operation();
    if (result.code === 0) return result;
    if (config.clock() >= deadline) throw new Error(code);
    await config.wait(100);
  }
}

function exactCanceledTask(output, mapping) {
  let parsed;
  try {
    parsed = parseOfficialJobInfo(output, mapping.jobId);
  } catch {
    return false;
  }
  const tasks = parsed.job.tasks.filter(
    (task) => canonicalOfficialJobId(task.id) === mapping.taskId,
  );
  return (
    tasks.length === 1 &&
    typeof tasks[0].state === "string" &&
    tasks[0].state.toLowerCase() === "canceled"
  );
}

async function observeCanceled(config, global, mapping) {
  const deadline = config.clock() + 8_000;
  for (;;) {
    const result = await config.runner.run(
      config.binaryPath,
      [...global, "job", "info", mapping.jobId, "--output-mode", "json"],
      { timeoutMs: 2_000 },
    );
    if (result.code === 0 && exactCanceledTask(result.stdout, mapping)) return;
    if (config.clock() >= deadline)
      throw new Error("hyperqueue_cancel_terminal_observation_missing");
    await config.wait(100);
  }
}

export async function stopHyperQueueCompatibilityProcesses({
  server,
  stopProcess,
  worker,
}) {
  if (
    typeof stopProcess !== "function" ||
    (server !== undefined && (server === null || typeof server !== "object")) ||
    (worker !== undefined && (worker === null || typeof worker !== "object"))
  )
    throw new Error("hyperqueue_cleanup_input_invalid");
  if (worker !== undefined) await stopProcess(worker);
  if (server !== undefined) await stopProcess(server);
}

function parseGatewayProbeResult(result, operation) {
  if (
    result === null ||
    typeof result !== "object" ||
    result.code !== 0 ||
    result.stderr !== "" ||
    typeof result.stdout !== "string" ||
    !result.stdout.endsWith("\n") ||
    result.stdout.slice(0, -1).includes("\n")
  )
    throw new Error("hyperqueue_gateway_probe_execution_failed");
  let evidence;
  try {
    evidence = JSON.parse(result.stdout);
  } catch {
    throw new Error("hyperqueue_gateway_probe_output_malformed");
  }
  if (
    evidence === null ||
    typeof evidence !== "object" ||
    Array.isArray(evidence)
  )
    throw new Error("hyperqueue_gateway_probe_output_invalid");
  const initial = operation === "submit-and-recover";
  const expectedKeys = initial
    ? [
        "actualCliReturnCallbacks",
        "durableReceiptReplayEqual",
        "gatewayRestartRecoveryReason",
        "jobId",
        "mappingRecordCount",
        "responseLossObserved",
        "submitIntentRecordCount",
        "walRecordCount",
        "walRecordKinds",
        "walSchemaVersion",
      ]
    : [
        "durableReceiptReplayEqual",
        "gatewayRecoveryReason",
        "jobId",
        "noResubmitOnRetry",
        "retainedExactJobMatches",
        "retainedHistoryCeiling",
        "walDigestStableAcrossRetry",
        "walRecordCount",
        "walSchemaVersion",
      ];
  if (
    Object.keys(evidence).sort().join() !== expectedKeys.sort().join() ||
    !/^(?:0|[1-9]\d*)$/u.test(evidence.jobId) ||
    evidence.durableReceiptReplayEqual !== true ||
    evidence.walSchemaVersion !== 2 ||
    !Number.isSafeInteger(evidence.walRecordCount) ||
    evidence.walRecordCount < 1
  )
    throw new Error("hyperqueue_gateway_probe_output_invalid");
  if (
    initial &&
    (evidence.actualCliReturnCallbacks !== 1 ||
      evidence.gatewayRestartRecoveryReason !==
        "authority_revalidation_required" ||
      evidence.mappingRecordCount !== 1 ||
      evidence.responseLossObserved !== true ||
      evidence.submitIntentRecordCount !== 1 ||
      !Array.isArray(evidence.walRecordKinds) ||
      evidence.walRecordKinds.filter((kind) => kind === "cli_intent").length !==
        1 ||
      evidence.walRecordKinds.filter((kind) => kind === "dispatch_mapping")
        .length !== 1 ||
      evidence.walRecordKinds.filter((kind) => kind === "effect_receipt")
        .length !== 1)
  )
    throw new Error("hyperqueue_gateway_probe_initial_evidence_invalid");
  if (
    !initial &&
    (evidence.gatewayRecoveryReason !== "authority_revalidation_required" ||
      evidence.noResubmitOnRetry !== true ||
      evidence.retainedExactJobMatches !== 1 ||
      evidence.retainedHistoryCeiling !== 1 ||
      evidence.walDigestStableAcrossRetry !== true)
  )
    throw new Error("hyperqueue_gateway_probe_restart_evidence_invalid");
  return Object.freeze(evidence);
}

export async function runHyperQueueCompatibilityProbe(config) {
  const release = await verifyHyperQueueRelease({
    archivePath: config.archivePath,
    binaryPath: config.binaryPath,
    runner: config.runner,
  });
  if (
    !OWNED_RESOURCE_PATTERN.test(config.jobName) ||
    !config.serverDirectory.startsWith("/") ||
    !config.gatewayWalPath.startsWith("/") ||
    !config.syntheticShimExecutable.startsWith("/") ||
    typeof config.executeGatewayProbe !== "function"
  )
    throw new Error("unsafe_hyperqueue_gate_probe");
  const global = ["--server-dir", config.serverDirectory];
  let server = await config.startProcess(
    config.binaryPath,
    [...global, "server", "start", "--host", "127.0.0.1"],
    "hq-server",
  );
  let worker;
  try {
    await poll(
      config,
      () =>
        config.runner.run(
          config.binaryPath,
          [...global, "server", "info", "--output-mode", "json"],
          { timeoutMs: 2_000 },
        ),
      "hyperqueue_server_start_timeout",
    );
    worker = await config.startProcess(
      config.binaryPath,
      [...global, "worker", "start", "--cpus", "2"],
      "hq-worker",
    );
    const inventory = await poll(
      config,
      () =>
        config.runner.run(
          config.binaryPath,
          [...global, "worker", "list", "--output-mode", "json"],
          { timeoutMs: 2_000 },
        ),
      "hyperqueue_worker_start_timeout",
    );
    const workers = parseOfficialArray(inventory.stdout, "worker_list");
    if (workers.length < 1)
      throw new Error("hyperqueue_worker_inventory_empty");
    const initialGatewayEvidence = parseGatewayProbeResult(
      await config.executeGatewayProbe({
        binarySha256: release.binarySha256,
        operation: "submit-and-recover",
      }),
      "submit-and-recover",
    );
    const mapping = Object.freeze({
      jobId: initialGatewayEvidence.jobId,
      taskId: "0",
    });
    const info = await poll(
      config,
      () =>
        config.runner.run(
          config.binaryPath,
          [...global, "job", "info", mapping.jobId, "--output-mode", "json"],
          { timeoutMs: 2_000 },
        ),
      "hyperqueue_job_info_timeout",
    );
    parseOfficialJobInfo(info.stdout, mapping.jobId);
    const canceled = await config.runner.run(
      config.binaryPath,
      officialHyperQueueCancelArguments(config.serverDirectory, mapping.jobId),
      { timeoutMs: 10_000 },
    );
    parseOfficialCancel(successful(canceled, "hyperqueue_cancel_failed"));
    await observeCanceled(config, global, mapping);
    await config.stopProcess(worker);
    worker = undefined;
    await config.stopProcess(server);
    server = undefined;
    server = await config.startProcess(
      config.binaryPath,
      [...global, "server", "start", "--host", "127.0.0.1"],
      "hq-server",
    );
    await poll(
      config,
      () =>
        config.runner.run(
          config.binaryPath,
          [...global, "server", "info", "--output-mode", "json"],
          { timeoutMs: 2_000 },
        ),
      "hyperqueue_server_journal_restart_timeout",
    );
    worker = await config.startProcess(
      config.binaryPath,
      [...global, "worker", "start", "--cpus", "2"],
      "hq-worker",
    );
    const restartedInventory = await poll(
      config,
      () =>
        config.runner.run(
          config.binaryPath,
          [...global, "worker", "list", "--output-mode", "json"],
          { timeoutMs: 2_000 },
        ),
      "hyperqueue_worker_journal_restart_timeout",
    );
    if (parseOfficialArray(restartedInventory.stdout, "worker_list").length < 1)
      throw new Error("hyperqueue_worker_restart_inventory_empty");
    const postRestartGatewayEvidence = parseGatewayProbeResult(
      await config.executeGatewayProbe({
        binarySha256: release.binarySha256,
        operation: "replay-after-server-restart",
      }),
      "replay-after-server-restart",
    );
    if (
      postRestartGatewayEvidence.jobId !== mapping.jobId ||
      postRestartGatewayEvidence.walRecordCount !==
        initialGatewayEvidence.walRecordCount
    )
      throw new Error("hyperqueue_gateway_journal_restart_identity_mismatch");
    return Object.freeze({
      ...release,
      boundedHistoryCeiling: 1,
      builtGatewayClient: "SchedulerMutationGatewayClient",
      builtMutationBoundary: "HyperQueueMutationBoundary",
      cancelSchema: "empty_object",
      cancelTerminalObservation: "exact_job_and_task_canceled",
      durableGatewayReceiptReplayed: true,
      gatewayWalSchemaVersion: initialGatewayEvidence.walSchemaVersion,
      jobInfoSchema: "array_with_nested_info_id",
      operationLookupContract:
        "gateway_response_lost_then_wal_recovery_exact_name_one_match",
      operationLookupSchema: "exact_hq_v0_26_2_job_list_row",
      retainedExactJobMatches:
        postRestartGatewayEvidence.retainedExactJobMatches,
      retainedLookupAfterJournalRestart: true,
      responseLossSimulated: true,
      submitCalls: initialGatewayEvidence.actualCliReturnCallbacks,
      submitResponse: "lost_after_cli_result_before_mapping_persist",
      submittedJobId: mapping.jobId,
      walDigestStableAcrossRetry:
        postRestartGatewayEvidence.walDigestStableAcrossRetry,
      workerListSchema: "array",
    });
  } finally {
    await stopHyperQueueCompatibilityProcesses({
      server,
      stopProcess: config.stopProcess,
      worker,
    });
  }
}
