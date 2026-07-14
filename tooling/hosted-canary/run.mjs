#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  posix,
  resolve,
  win32,
} from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";

import { prepareRuntimeExecutionTicket } from "@workload-funnel/bridge-subscription-runtime/execution-ticket-preparation";
import {
  assertDeployedCliHelp,
  assertDeployedToolsCatalog,
  FilesystemHostedCanaryAuthorityStore,
  FilesystemRuntimeOperationStore,
  HOSTED_CANARY_RUNTIME_CONTRACT,
  HostedCanaryRuntimeAdapter,
} from "@workload-funnel/bridge-subscription-runtime/runtime-operation-dispatch";
import { fingerprintMutationFence } from "@workload-funnel/kernel";

import {
  CANARY_EXPECTED_ARTIFACT_FILE,
  canaryEnvironment,
  DISPOSABLE_SENTINEL_PURPOSE,
  validateDisposableProject,
  verifyNaturalCompletionArtifact,
} from "./disposable-project.mjs";
import { createNodeHostedCanaryProcessRunner } from "./node-process-runner.mjs";
import { createTrustedInvocationProfileResolver } from "./trusted-invocation-profile.mjs";

const LIVE_OPT_IN = "WORKLOAD_FUNNEL_DISPOSABLE_CANARY_LIVE";
const CANARY_PRIVATE_CHANGED_PATH_ROOT = ".workload-funnel-canary";
const CANARY_PRIVATE_CHANGED_PATH_PREFIX = `${CANARY_PRIVATE_CHANGED_PATH_ROOT}/`;
export const HOSTED_CANARY_CHANGED_FILES_MAX_ITEMS = 512;
export const HOSTED_CANARY_TERMINAL_RESULT_MAX_BYTES = 256 * 1024;
const HOSTED_CANARY_RESULT_LIST_MAX_ITEMS = 128;
const HOSTED_CANARY_RESULT_STRING_MAX_LENGTH = 8 * 1024;
const DEFAULT_CAPABILITY_OUTPUT_BYTES = 256 * 1024;
const MAX_CAPABILITY_OUTPUT_BYTES = 2 * 1024 * 1024;
const limitations = Object.freeze([
  "canary_only_not_production_enablement",
  "does_not_prove_real_postgres_readiness",
  "does_not_prove_systemd_or_cgroup_readiness",
  "does_not_prove_object_store_readiness",
  "deployed_runtime_cli_does_not_supply_production_runtime_broker_fencing",
  "runtime_internal_side_effects_are_not_observed_by_this_harness",
  "credential_files_and_foreground_output_are_not_read_by_this_harness",
]);

function parseArguments(argv) {
  const mode = argv[0];
  if (mode !== "live" && mode !== "probe")
    throw new Error("hosted_canary_mode_invalid");
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      typeof key !== "string" ||
      !key.startsWith("--") ||
      typeof value !== "string" ||
      values.has(key)
    )
      throw new Error("hosted_canary_cli_arguments_invalid");
    values.set(key, value);
  }
  const required = [
    "--project-root",
    "--request",
    "--runtime-binary",
    "--sandbox-parent",
  ];
  if (mode === "live")
    required.push(
      "--evidence",
      "--expected-cli-help-sha256",
      "--expected-runtime-sha256",
      "--expected-tools-catalog-sha256",
      "--invocation-profile",
      "--live-opt-in",
    );
  if (required.some((key) => !values.has(key)))
    throw new Error("hosted_canary_cli_arguments_missing");
  const allowed = new Set([
    ...required,
    "--foreground-timeout-ms",
    "--max-output-bytes",
    "--observation-window-ms",
    "--probe-timeout-ms",
    "--scenario",
  ]);
  if ([...values.keys()].some((key) => !allowed.has(key)))
    throw new Error("hosted_canary_cli_argument_unknown");
  return Object.freeze({ mode, values });
}

function liveScenario(values) {
  const scenario = values.get("--scenario") ?? "natural_completion";
  if (scenario !== "natural_completion" && scenario !== "forced_stop")
    throw new Error("hosted_canary_scenario_invalid");
  return scenario;
}

function required(values, key) {
  const value = values.get(key);
  if (value === undefined)
    throw new Error("hosted_canary_cli_arguments_missing");
  return value;
}

function requiredAbsolute(values, key) {
  const value = required(values, key);
  if (!isAbsolute(value))
    throw new Error("hosted_canary_absolute_path_required");
  return value;
}

function boundedInteger(values, key, defaultValue, minimum, maximum) {
  const raw = values.get(key);
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error("hosted_canary_cli_limit_invalid");
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeEvidence(path, evidence) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertFileAbsent(path, code) {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw new Error(code);
  }
  throw new Error(code);
}

function isMissing(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function strictStringArray(value, maximumItems) {
  return (
    Array.isArray(value) &&
    value.length <= maximumItems &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length <= HOSTED_CANARY_RESULT_STRING_MAX_LENGTH &&
        !item.includes("\u0000"),
    )
  );
}

function isNormalizedRelativeChangedPath(path) {
  if (
    path.length === 0 ||
    path.includes("\\") ||
    [...path].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    }) ||
    posix.isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    path.normalize("NFC") !== path ||
    posix.normalize(path) !== path
  )
    return false;
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertExpectedPublicChangedFiles(changedFiles) {
  const normalizedPaths = new Set();
  const publicPaths = [];
  for (const path of changedFiles) {
    if (!isNormalizedRelativeChangedPath(path) || normalizedPaths.has(path))
      throw new Error("hosted_canary_terminal_result_unexpected_paths");
    normalizedPaths.add(path);
    if (path === CANARY_PRIVATE_CHANGED_PATH_ROOT)
      throw new Error("hosted_canary_terminal_result_unexpected_paths");
    if (path.startsWith(CANARY_PRIVATE_CHANGED_PATH_PREFIX)) continue;
    publicPaths.push(path);
  }
  if (
    publicPaths.length !== 1 ||
    publicPaths[0] !== CANARY_EXPECTED_ARTIFACT_FILE
  )
    throw new Error("hosted_canary_terminal_result_unexpected_paths");
}

async function readSuccessfulTerminalResult(path, taskId) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_RDONLY,
    );
  } catch (error) {
    if (isMissing(error))
      throw new Error("hosted_canary_terminal_result_missing");
    throw new Error("hosted_canary_terminal_result_invalid");
  }
  let contents;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size < 2 ||
      metadata.size > HOSTED_CANARY_TERMINAL_RESULT_MAX_BYTES ||
      (metadata.mode & 0o022) !== 0 ||
      (process.getuid !== undefined && metadata.uid !== process.getuid())
    )
      throw new Error("hosted_canary_terminal_result_invalid");
    contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.size !== metadata.size
    )
      throw new Error("hosted_canary_terminal_result_changed");
  } finally {
    await handle.close();
  }
  let result;
  try {
    result = JSON.parse(contents);
  } catch {
    throw new Error("hosted_canary_terminal_result_invalid");
  }
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result) ||
    result.schemaVersion !== 1 ||
    result.provider !== "codex" ||
    result.runId !== taskId ||
    result.taskId !== taskId ||
    !strictStringArray(
      result.changedFiles,
      HOSTED_CANARY_CHANGED_FILES_MAX_ITEMS,
    ) ||
    !strictStringArray(result.evidence, HOSTED_CANARY_RESULT_LIST_MAX_ITEMS) ||
    !strictStringArray(result.blockers, HOSTED_CANARY_RESULT_LIST_MAX_ITEMS) ||
    typeof result.status !== "string" ||
    typeof result.nextAction !== "string" ||
    typeof result.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(result.updatedAt))
  )
    throw new Error("hosted_canary_terminal_result_invalid");
  if (
    result.status !== "done" ||
    result.nextAction !== "review_completed" ||
    result.blockers.length !== 0
  )
    throw new Error("hosted_canary_terminal_result_contradictory");
  assertExpectedPublicChangedFiles(result.changedFiles);
  return Object.freeze({ status: result.status });
}

function startFence(project, nowMs) {
  const suffix = project.sentinel.nonce.slice(0, 32);
  return Object.freeze({
    allocationId: `canary-allocation-${suffix}`,
    attemptId: `canary-attempt-${suffix}`,
    clusterIncarnation: `canary-cluster-${suffix}`,
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: `runtime-canary:${suffix}`,
    executionGeneration: `canary-generation-${suffix}`,
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: `test://hosted-canary/${suffix}`,
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "codex-workers-eu-01-canary",
    notAfter: nowMs + 15 * 60_000,
    notBefore: nowMs - 1_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: `canary-start-fence-${suffix}`,
    supersessionKey: `runtime-canary-start:${suffix}`,
  });
}

function stopFence(start) {
  const stop = {
    ...start,
    desiredEffect: "process_stop",
    expectedDesiredVersion: start.expectedDesiredVersion + 1,
    operationGateRevision: start.operationGateRevision + 1,
    requiredGate: "process_stop",
    supersessionKey: `${start.supersessionKey}:stop`,
  };
  delete stop.startFence;
  delete stop.issuedStartRevocationRevision;
  return Object.freeze(stop);
}

function ticket(project, fence) {
  const fingerprint = fingerprintMutationFence(fence);
  const suffix = project.sentinel.nonce.slice(0, 32);
  return prepareRuntimeExecutionTicket(
    Object.freeze({
      causationId: `canary-cause-${suffix}`,
      correlationId: `canary-correlation-${suffix}`,
      expiresAtMs: fence.notAfter,
      idempotencyKey: `canary-idempotency-${suffix}`,
      issuedAtMs: fence.notBefore,
      mutationFence: fence,
      mutationFenceFingerprint: fingerprint,
      operationId: `canary-operation-${suffix}`,
      projectId: `disposable-canary-${suffix}`,
      requestId: `canary-request-${suffix}`,
      runtimeTargetId: `hosted-runtime-${suffix}`,
      sandboxProfileDigest: sha256("hosted-disposable-canary-profile-v1"),
      ticketId: `canary-ticket-${suffix}`,
    }),
  );
}

function baseEvidence(mode, project) {
  return {
    kind: "workload-funnel.hosted-subscription-runtime-canary.v1",
    limitations,
    mode,
    productionStartsEnabled: false,
    project: {
      disposable: true,
      fingerprint: project.projectFingerprint,
      purpose: DISPOSABLE_SENTINEL_PURPOSE,
      root: project.projectRoot,
    },
    safety: {
      dbusRequestedByHarness: false,
      dockerSocketRequestedByHarness: false,
      credentialMaterialReadByHarness: false,
      foregroundOutputCaptured: false,
      foregroundModeRequiresNoTmux: true,
      hyperQueueRequestedByHarness: false,
      networkServiceRequestedByHarness: false,
      productionStartsEnabled: false,
      shellUsed: false,
      startToolInvoked: false,
      systemdRequestedByHarness: false,
    },
    schemaVersion: 1,
  };
}

async function probe(parsed, project, runner, environment) {
  const executable = requiredAbsolute(parsed.values, "--runtime-binary");
  const identity = await runner.inspectExecutable(executable);
  const request = (argv) => ({
    argv,
    cwd: project.projectRoot,
    environment,
    executable,
    expectedExecutableIdentity: identity,
    maxOutputBytes: boundedInteger(
      parsed.values,
      "--max-output-bytes",
      DEFAULT_CAPABILITY_OUTPUT_BYTES,
      1_024,
      MAX_CAPABILITY_OUTPUT_BYTES,
    ),
    timeoutMs: boundedInteger(
      parsed.values,
      "--probe-timeout-ms",
      10_000,
      1,
      60_000,
    ),
  });
  const cliHelp = await runner.run(request(["--help"]));
  const toolsCatalog = await runner.run(request(["tools"]));
  if (
    cliHelp.exitCode !== 0 ||
    toolsCatalog.exitCode !== 0 ||
    cliHelp.timedOut ||
    toolsCatalog.timedOut
  )
    throw new Error("hosted_canary_capability_probe_failed");
  assertDeployedCliHelp(cliHelp.stdout);
  assertDeployedToolsCatalog(toolsCatalog.stdout);
  return {
    ...baseEvidence("probe", project),
    outcome: "probe_only",
    runtime: {
      binarySha256: identity.sha256,
      contractVersion: HOSTED_CANARY_RUNTIME_CONTRACT,
      cliHelpSha256: sha256(cliHelp.stdout),
      toolsCatalogSha256: sha256(toolsCatalog.stdout),
    },
  };
}

async function waitForForeground(adapter, maximumWaitMs) {
  const completion = adapter.foregroundCompletion();
  if (completion === undefined) return undefined;
  const settled = completion.catch(() => undefined);
  let timeout;
  const result = await Promise.race([
    settled,
    new Promise((resolvePromise) => {
      timeout = setTimeout(() => resolvePromise(undefined), maximumWaitMs);
    }),
  ]);
  clearTimeout(timeout);
  if (result !== undefined) return result;
  adapter.terminateForeground();
  let killTimeout;
  const killed = await Promise.race([
    settled,
    new Promise((resolvePromise) => {
      killTimeout = setTimeout(() => resolvePromise(undefined), maximumWaitMs);
    }),
  ]);
  clearTimeout(killTimeout);
  return killed;
}

async function live(
  parsed,
  project,
  runner,
  runtimeEnvironment,
  commandEnvironment,
) {
  if (
    required(parsed.values, "--live-opt-in") !== LIVE_OPT_IN ||
    commandEnvironment["WORKLOAD_FUNNEL_HOSTED_CANARY_LIVE"] !== "1"
  )
    throw new Error("hosted_canary_live_opt_in_missing");
  const executable = requiredAbsolute(parsed.values, "--runtime-binary");
  const scenario = liveScenario(parsed.values);
  if (basename(executable) !== "subscription-runtime-codex-goal")
    throw new Error("hosted_canary_runtime_binary_not_allowlisted");
  const evidencePath = requiredAbsolute(parsed.values, "--evidence");
  if (
    dirname(evidencePath) !== project.stateRoot ||
    basename(evidencePath) !== "hosted-canary-evidence.json"
  )
    throw new Error("hosted_canary_evidence_path_outside_state_root");
  await assertFileAbsent(evidencePath, "hosted_canary_evidence_already_exists");
  if (scenario === "natural_completion")
    await assertFileAbsent(
      resolve(project.stateRoot, "runtime-result.json"),
      "hosted_canary_terminal_result_already_exists",
    );
  const release = Object.freeze({
    contractVersion: HOSTED_CANARY_RUNTIME_CONTRACT,
    executable,
    expectedBinarySha256: required(parsed.values, "--expected-runtime-sha256"),
    expectedCliHelpSha256: required(
      parsed.values,
      "--expected-cli-help-sha256",
    ),
    expectedToolsCatalogSha256: required(
      parsed.values,
      "--expected-tools-catalog-sha256",
    ),
    limits: Object.freeze({
      foregroundTimeoutMs: boundedInteger(
        parsed.values,
        "--foreground-timeout-ms",
        120_000,
        1,
        15 * 60_000,
      ),
      maxOutputBytes: boundedInteger(
        parsed.values,
        "--max-output-bytes",
        DEFAULT_CAPABILITY_OUTPUT_BYTES,
        1_024,
        MAX_CAPABILITY_OUTPUT_BYTES,
      ),
      probeTimeoutMs: boundedInteger(
        parsed.values,
        "--probe-timeout-ms",
        10_000,
        1,
        60_000,
      ),
    }),
    productionStartsEnabled: false,
  });
  const profileResolver = createTrustedInvocationProfileResolver({
    profilePath: requiredAbsolute(parsed.values, "--invocation-profile"),
    projectRoot: project.projectRoot,
  });
  const adapter = new HostedCanaryRuntimeAdapter({
    authorityStore: new FilesystemHostedCanaryAuthorityStore({
      directory: resolve(project.stateRoot, "bridge-authority"),
    }),
    controllerId: "workload-funnel-hosted-canary",
    nowMs: () => Date.now(),
    operationStore: new FilesystemRuntimeOperationStore({
      capacity: 64,
      directory: resolve(project.stateRoot, "bridge-operations"),
    }),
    profileResolver,
    release,
    runner,
    sandbox: {
      canaryPurpose: DISPOSABLE_SENTINEL_PURPOSE,
      environment: runtimeEnvironment,
      jobRoot: project.jobRoot,
      projectRoot: project.projectRoot,
      projectFingerprint: project.projectFingerprint,
      registryRoot: project.registryRoot,
      stateRoot: project.stateRoot,
      temporaryRoot: project.temporaryRoot,
    },
  });
  const startedAtMs = Date.now();
  const processStartFence = startFence(project, startedAtMs);
  const preparedTicket = ticket(project, processStartFence);
  let foregroundCompletion;
  let foregroundExitedBeforeStop = false;
  let expectedArtifact = null;
  let outerTermination = "not_requested";
  let terminalResultStatus = null;
  let runtime;
  let start;
  let stop;
  let failureCode;
  const relaySignal = (signal) => {
    adapter.terminateForeground();
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    process.kill(process.pid, signal);
  };
  const onInterrupt = () => relaySignal("SIGINT");
  const onTerminate = () => relaySignal("SIGTERM");
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  try {
    await adapter.installAuthority(
      processStartFence,
      fingerprintMutationFence(processStartFence),
    );
    runtime = await adapter.discoverCapabilities();
    start = await adapter.start({
      invocationProfileId: project.request.invocationProfileId,
      promptPath: project.request.promptPath,
      taskId: project.request.taskId,
      ticket: preparedTicket,
    });
    const foreground = adapter.foregroundCompletion();
    if (start.state !== "accepted" || foreground === undefined)
      throw new Error("hosted_canary_foreground_start_ambiguous");
    if (scenario === "natural_completion") {
      foregroundCompletion = await foreground;
      if (foregroundCompletion.timedOut) {
        outerTermination = "timeout_kill";
        throw new Error("hosted_canary_foreground_timeout");
      }
      if (foregroundCompletion.exitCode !== 0)
        throw new Error("hosted_canary_foreground_exit_unsuccessful");
      const terminal = await readSuccessfulTerminalResult(
        resolve(project.stateRoot, "runtime-result.json"),
        project.request.taskId,
      );
      terminalResultStatus = terminal.status;
      expectedArtifact = await verifyNaturalCompletionArtifact(project);
    } else {
      const observationWindowMs = boundedInteger(
        parsed.values,
        "--observation-window-ms",
        250,
        10,
        5_000,
      );
      let observationTimeout;
      foregroundExitedBeforeStop = await Promise.race([
        foreground.then(
          () => true,
          () => true,
        ),
        new Promise((resolvePromise) => {
          observationTimeout = setTimeout(
            () => resolvePromise(false),
            observationWindowMs,
          );
        }),
      ]);
      clearTimeout(observationTimeout);
      if (foregroundExitedBeforeStop)
        throw new Error("hosted_canary_foreground_exited_before_forced_stop");
      const processStopFence = stopFence(processStartFence);
      await adapter.installAuthority(
        processStopFence,
        fingerprintMutationFence(processStopFence),
      );
      stop = await adapter.stop({
        mutationFence: processStopFence,
        mutationFenceFingerprint: fingerprintMutationFence(processStopFence),
        operationId: preparedTicket.operationId,
        runtimeTargetId: preparedTicket.runtimeTargetId,
      });
      foregroundCompletion = stop.foregroundCompletion;
      outerTermination = stop.receipt.state;
    }
  } catch (error) {
    failureCode = safeErrorCode(error);
    if (
      foregroundCompletion === undefined &&
      adapter.foregroundCompletion() !== undefined
    ) {
      adapter.terminateForeground();
      outerTermination = "cleanup_kill";
    }
  } finally {
    if (
      foregroundCompletion === undefined &&
      adapter.foregroundCompletion() !== undefined
    )
      foregroundCompletion = await waitForForeground(adapter, 5_000);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
  if (runtime === undefined)
    throw new Error(failureCode ?? "hosted_canary_capability_discovery_failed");
  const passed =
    start !== undefined &&
    start.state === "accepted" &&
    foregroundCompletion !== undefined &&
    foregroundCompletion.timedOut === false &&
    !foregroundExitedBeforeStop &&
    failureCode === undefined &&
    (scenario === "natural_completion"
      ? foregroundCompletion.exitCode === 0 &&
        terminalResultStatus === "done" &&
        expectedArtifact?.verified === true &&
        outerTermination === "not_requested"
      : stop?.receipt.state === "completed" &&
        outerTermination === "completed" &&
        foregroundCompletion.exitCode === null);
  const evidence = {
    ...baseEvidence("live", project),
    completedAtMs: Date.now(),
    operations: {
      completionMode: scenario,
      expectedArtifact,
      foregroundExitCode: foregroundCompletion?.exitCode ?? null,
      ...(scenario === "forced_stop" ? { foregroundExitedBeforeStop } : {}),
      foregroundStart: start?.foregroundStart.state ?? "not_attempted",
      foregroundTimedOut: foregroundCompletion?.timedOut ?? null,
      outerTermination,
      terminalResultStatus,
    },
    outcome: passed ? "passed" : "unknown",
    runtime,
    startedAtMs,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
  await writeEvidence(evidencePath, evidence);
  return evidence;
}

export async function runHostedCanaryCommand(argv, environment = process.env) {
  const parsed = parseArguments(argv);
  const nowMs = Date.now();
  const project = await validateDisposableProject({
    maximumAgeMs: 60 * 60_000,
    nowMs,
    projectRoot: required(parsed.values, "--project-root"),
    requestPath: required(parsed.values, "--request"),
    sandboxParent: required(parsed.values, "--sandbox-parent"),
    workspaceRoot: resolve(import.meta.dirname, "../.."),
  });
  const runner = createNodeHostedCanaryProcessRunner();
  const runtimeEnvironment = canaryEnvironment(project);
  return parsed.mode === "probe"
    ? await probe(parsed, project, runner, runtimeEnvironment)
    : await live(parsed, project, runner, runtimeEnvironment, environment);
}

function safeErrorCode(error) {
  const message =
    error instanceof Error ? error.message : "hosted_canary_failed";
  return /^[a-z0-9_.:-]{1,160}$/u.test(message)
    ? message
    : "hosted_canary_failed";
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    const evidence = await runHostedCanaryCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    process.exitCode = evidence.outcome === "unknown" ? 3 : 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({ error: safeErrorCode(error), productionStartsEnabled: false })}\n`,
    );
    process.exitCode = 2;
  }
}
