import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify, TextEncoder } from "node:util";

import {
  createSchedulerMutationGateway,
  startSchedulerMutationGateway,
} from "../../../apps/scheduler-mutation-gateway/dist/features/composition/index.js";
import { SimulatedGatewayCrash } from "../../../apps/scheduler-mutation-gateway/dist/features/hyperqueue-mutation-boundary/index.js";
import { fingerprintMutationFence } from "../../../packages/kernel/dist/index.js";
import {
  SCHEDULER_GATEWAY_PROTOCOL,
  signSchedulerFenceInstall,
} from "../../../packages/scheduler-hyperqueue/dist/features/mutation-gateway-authority/index.js";
import { parseHyperQueueOperationLookup } from "../../../packages/scheduler-hyperqueue/dist/features/operation-lookup/index.js";

const executeFile = promisify(execFile);
const RETAINED_HISTORY_CEILING = 1;
const acknowledgementKey = new TextEncoder().encode(
  "production-gate-acknowledgement-key-v1",
);
const issuerKey = new TextEncoder().encode(
  "production-gate-issuer-key-v1-0001",
);
const exactArguments = new Set([
  "--binary",
  "--binary-sha256",
  "--operation",
  "--operation-key",
  "--server-directory",
  "--shim-executable",
  "--wal-path",
]);

function parseArguments(argv) {
  if (argv.length !== exactArguments.size * 2)
    throw new Error("hyperqueue_gateway_probe_arguments_invalid");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !exactArguments.has(key) ||
      Object.hasOwn(values, key) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.includes("\0")
    )
      throw new Error("hyperqueue_gateway_probe_arguments_invalid");
    values[key] = value;
  }
  if (
    !new Set(["replay-after-server-restart", "submit-and-recover"]).has(
      values["--operation"],
    ) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(values["--operation-key"]) ||
    !/^[a-f0-9]{64}$/u.test(values["--binary-sha256"]) ||
    ![
      "--binary",
      "--server-directory",
      "--shim-executable",
      "--wal-path",
    ].every((key) => values[key].startsWith("/"))
  )
    throw new Error("hyperqueue_gateway_probe_arguments_invalid");
  return Object.freeze({
    binaryPath: values["--binary"],
    binarySha256: values["--binary-sha256"],
    operation: values["--operation"],
    operationKey: values["--operation-key"],
    serverDirectory: values["--server-directory"],
    shimExecutable: values["--shim-executable"],
    walPath: values["--wal-path"],
  });
}

function gatewayConfig(config, faults) {
  return {
    acknowledgementKey,
    authorityId: "production-gate-hq-gateway",
    credential: {
      hyperQueueExecutable: config.binaryPath,
      mutationServerDirectory: config.serverDirectory,
    },
    ...(faults === undefined ? {} : { faults }),
    mode: "synthetic_research",
    nowMs: Date.now,
    release: {
      exactVersion: "0.26.2",
      expectedBinarySha256: config.binarySha256,
      limits: {
        maxOutputBytes: 128 * 1024,
        maxRetainedJobs: RETAINED_HISTORY_CEILING,
        timeoutMs: 10_000,
      },
      shimExecutable: config.shimExecutable,
    },
    trustedInstallKeys: new Map([["production-gate-issuer-v1", issuerKey]]),
    walCapacity: 64,
    walPath: config.walPath,
  };
}

function scope(config) {
  return Object.freeze({
    allocationId: `${config.operationKey}-allocation`,
    attemptId: `${config.operationKey}-attempt`,
    dispatchId: `${config.operationKey}-dispatch`,
    effectKind: "dispatch_submit",
    executionGeneration: `${config.operationKey}-generation`,
    namespaceId: `production-gate://${config.operationKey}`,
    schedulerInstanceId: `${config.operationKey}-scheduler`,
  });
}

function mutationFence(config, targetScope, nowMs) {
  return Object.freeze({
    allocationId: targetScope.allocationId,
    attemptId: targetScope.attemptId,
    clusterIncarnation: `${config.operationKey}-cluster`,
    clusterIncarnationVersion: 1,
    desiredEffect: "dispatch_submit",
    effectScopeKey: `scheduler-dispatch:${targetScope.dispatchId}`,
    executionGeneration: targetScope.executionGeneration,
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: targetScope.namespaceId,
    namespaceWriterEpoch: 1,
    notAfter: nowMs + 10 * 60_000,
    notBefore: nowMs - 1_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "dispatch_submit",
    schemaVersion: 1,
    startFence: `${config.operationKey}-start-fence`,
    supersessionKey: `dispatch:${targetScope.dispatchId}`,
  });
}

async function installAndOpen(gateway, config) {
  const targetScope = scope(config);
  const nowMs = Date.now();
  const fence = mutationFence(config, targetScope, nowMs);
  await gateway.closeAndDrain({
    authorityId: "production-gate-hq-gateway",
    closeOperationId: `${config.operationKey}-close`,
    scope: targetScope,
  });
  const acknowledgement = await gateway.install(
    signSchedulerFenceInstall(
      Object.freeze({
        authorityId: "production-gate-hq-gateway",
        expectedPriorFingerprint: null,
        installOperationId: `${config.operationKey}-install`,
        issuedAtMs: nowMs,
        issuerKeyId: "production-gate-issuer-v1",
        mutationFence: fence,
        mutationFenceFingerprint: fingerprintMutationFence(fence),
        notAfterMs: nowMs + 10 * 60_000,
        protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
        reason: "desired_effect_supersession",
        scope: targetScope,
      }),
      issuerKey,
    ),
  );
  await gateway.reopen({
    acknowledgement,
    reopenOperationId: `${config.operationKey}-reopen`,
  });
  const mappingFingerprint = `mapping-${createHash("sha256")
    .update(config.operationKey, "utf8")
    .digest("hex")}`;
  return Object.freeze({
    acknowledgedInstall: acknowledgement,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId: `${config.operationKey}-submit-operation`,
    payload: Object.freeze({
      dispatchId: targetScope.dispatchId,
      kind: "submit",
      mappingFingerprint,
      requestedCpuCount: 1,
      requiredCustomResources: Object.freeze({}),
      restartPolicy: "never",
      shimInvocationBase64: Buffer.from("{}", "utf8").toString("base64url"),
    }),
    protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
    scope: targetScope,
  });
}

function walState(path) {
  const content = readFileSync(path, "utf8");
  if (!content.endsWith("\n"))
    throw new Error("hyperqueue_gateway_probe_wal_truncated");
  const envelopes = content
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line));
  if (
    envelopes.length < 1 ||
    envelopes.some(
      (envelope, index) =>
        envelope.schemaVersion !== 2 ||
        envelope.sequence !== index + 1 ||
        typeof envelope.record?.kind !== "string",
    )
  )
    throw new Error("hyperqueue_gateway_probe_wal_invalid");
  const records = envelopes.map((envelope) => envelope.record);
  const cliIntents = records.filter((record) => record.kind === "cli_intent");
  const mappings = records.filter(
    (record) => record.kind === "dispatch_mapping",
  );
  const receipts = records.filter((record) => record.kind === "effect_receipt");
  if (cliIntents.length !== 1 || mappings.length !== 1 || receipts.length !== 1)
    throw new Error("hyperqueue_gateway_probe_wal_lifecycle_invalid");
  return Object.freeze({
    cliIntent: cliIntents[0],
    digest: createHash("sha256").update(content, "utf8").digest("hex"),
    mapping: mappings[0].mapping,
    recordCount: records.length,
    recordKinds: Object.freeze(records.map((record) => record.kind)),
  });
}

function exactAppliedReceipt(receipt, expectedJobId) {
  if (
    receipt?.outcome !== "applied" ||
    receipt.reason !== "hyperqueue_operation_name_correlated" ||
    receipt.externalMappingOrInvocationId !== `hq://${expectedJobId}`
  )
    throw new Error("hyperqueue_gateway_probe_receipt_invalid");
}

async function submitAndRecover(config) {
  let actualCliReturnCallbacks = 0;
  const initial = createSchedulerMutationGateway(
    gatewayConfig(config, {
      afterCliCall() {
        actualCliReturnCallbacks += 1;
        throw new SimulatedGatewayCrash();
      },
    }),
  );
  const initialRecovery = await startSchedulerMutationGateway(initial);
  if (!initialRecovery.mutationReady)
    throw new Error("hyperqueue_gateway_probe_initial_recovery_failed");
  const request = await installAndOpen(initial, config);
  let responseLossObserved = false;
  try {
    await initial.mutate(request);
  } catch (error) {
    responseLossObserved = error instanceof SimulatedGatewayCrash;
  }
  if (!responseLossObserved || actualCliReturnCallbacks !== 1)
    throw new Error("hyperqueue_gateway_probe_response_loss_unproven");

  const restarted = createSchedulerMutationGateway(gatewayConfig(config));
  const restartRecovery = await startSchedulerMutationGateway(restarted);
  if (
    restartRecovery.reason !== "authority_revalidation_required" ||
    restartRecovery.recoveredUnknownOperations.length !== 0
  )
    throw new Error("hyperqueue_gateway_probe_restart_recovery_failed");
  const replayed = await restarted.mutate(request);
  const retried = await restarted.mutate(request);
  if (JSON.stringify(replayed) !== JSON.stringify(retried))
    throw new Error("hyperqueue_gateway_probe_receipt_replay_mismatch");
  const state = walState(config.walPath);
  if (
    state.mapping.operationId !== request.operationId ||
    state.mapping.dispatchId !== request.payload.dispatchId ||
    state.mapping.mappingFingerprint !== request.payload.mappingFingerprint
  )
    throw new Error("hyperqueue_gateway_probe_mapping_invalid");
  exactAppliedReceipt(replayed, state.mapping.jobId);
  return Object.freeze({
    actualCliReturnCallbacks,
    durableReceiptReplayEqual: true,
    gatewayRestartRecoveryReason: restartRecovery.reason,
    jobId: state.mapping.jobId,
    mappingRecordCount: 1,
    responseLossObserved,
    submitIntentRecordCount: 1,
    walRecordCount: state.recordCount,
    walRecordKinds: state.recordKinds,
    walSchemaVersion: 2,
  });
}

async function retainedLookup(config, state) {
  const output = await executeFile(
    config.binaryPath,
    [
      "--server-dir",
      config.serverDirectory,
      "job",
      "list",
      "--all",
      "--output-mode",
      "json",
    ],
    {
      encoding: "utf8",
      killSignal: "SIGKILL",
      maxBuffer: 128 * 1024,
      shell: false,
      timeout: 10_000,
    },
  );
  if (
    output.stderr.length > 0 ||
    Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) >
      128 * 1024
  )
    throw new Error("hyperqueue_gateway_probe_retained_output_invalid");
  const retained = parseHyperQueueOperationLookup(
    output.stdout,
    state.mapping.canonicalJobName,
  );
  if (
    retained.disposition !== "one" ||
    retained.retainedJobCount !== RETAINED_HISTORY_CEILING ||
    retained.matches.length !== 1 ||
    retained.matches[0].jobId !== state.mapping.jobId
  )
    throw new Error("hyperqueue_gateway_probe_retained_job_invalid");
  return Object.freeze({
    ...retained,
    retainedHistoryCeiling: RETAINED_HISTORY_CEILING,
  });
}

async function replayAfterServerRestart(config) {
  const before = walState(config.walPath);
  const gateway = createSchedulerMutationGateway(gatewayConfig(config));
  const recovery = await startSchedulerMutationGateway(gateway);
  if (
    recovery.reason !== "authority_revalidation_required" ||
    recovery.recoveredUnknownOperations.length !== 0
  )
    throw new Error("hyperqueue_gateway_probe_post_restart_recovery_failed");
  const replayed = await gateway.mutate(before.cliIntent.request);
  const retried = await gateway.mutate(before.cliIntent.request);
  exactAppliedReceipt(replayed, before.mapping.jobId);
  if (JSON.stringify(replayed) !== JSON.stringify(retried))
    throw new Error("hyperqueue_gateway_probe_post_restart_replay_mismatch");
  const retained = await retainedLookup(config, before);
  const after = walState(config.walPath);
  if (
    before.digest !== after.digest ||
    before.recordCount !== after.recordCount ||
    before.mapping.jobId !== after.mapping.jobId
  )
    throw new Error("hyperqueue_gateway_probe_retry_mutated_state");
  return Object.freeze({
    durableReceiptReplayEqual: true,
    gatewayRecoveryReason: recovery.reason,
    jobId: after.mapping.jobId,
    noResubmitOnRetry: true,
    retainedExactJobMatches: retained.matches.length,
    retainedHistoryCeiling: retained.retainedHistoryCeiling,
    walDigestStableAcrossRetry: true,
    walRecordCount: after.recordCount,
    walSchemaVersion: 2,
  });
}

const config = parseArguments(process.argv.slice(2));
const evidence =
  config.operation === "submit-and-recover"
    ? await submitAndRecover(config)
    : await replayAfterServerRestart(config);
process.stdout.write(`${JSON.stringify(evidence)}\n`);
