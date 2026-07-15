import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { SignedExecutionTicket } from "@workload-funnel/node-execution/execution-ticket-validation";
import type { SchedulerShimInvocation } from "@workload-funnel/node-execution/scheduler-shim-entrypoint";
import { createSchedulerMutationGateway } from "@workload-funnel/scheduler-mutation-gateway/composition";
import type { GatewayMutationFaults } from "@workload-funnel/scheduler-mutation-gateway/hyperqueue-mutation-boundary";
import {
  SCHEDULER_GATEWAY_PROTOCOL,
  signSchedulerFenceInstall,
  type MutateHyperQueueRequest,
  type SchedulerMutationScope,
  type SignedSchedulerFenceInstallAcknowledgement,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";

const executeFile = promisify(execFile);
const fixturePath = fileURLToPath(
  new URL("./fixtures/hq-synthetic.mjs", import.meta.url),
);

export const nowMs = 1_000_000;
export const issuerKey = new TextEncoder().encode(
  "issuer-secret-phase7-32-byte-minimum",
);
export const acknowledgementKey = new TextEncoder().encode(
  "gateway-secret-phase7-32-byte-minimum",
);

export interface SyntheticGatewayEnvironment {
  readonly directory: string;
  readonly schedulerDirectory: string;
  readonly statePath: string;
  readonly walPath: string;
}

export function createSyntheticGatewayEnvironment(): SyntheticGatewayEnvironment {
  const directory = mkdtempSync(join(tmpdir(), "wf-phase7-hq-"));
  const schedulerDirectory = join(directory, "scheduler-private");
  mkdirSync(schedulerDirectory, { mode: 0o700 });
  chmodSync(schedulerDirectory, 0o700);
  const statePath = join(schedulerDirectory, "scheduler.json");
  writeFileSync(
    statePath,
    `${JSON.stringify({
      jobs: {},
      mutationCalls: 0,
      nextJobId: 1,
      serverEpoch: 1,
      submissions: {},
      workers: [
        {
          customResources: { gpu: 1 },
          state: "idle",
          workerId: "worker-1",
        },
      ],
      workerSequence: 1,
    })}\n`,
    { mode: 0o600 },
  );
  return Object.freeze({
    directory,
    schedulerDirectory,
    statePath,
    walPath: join(directory, "gateway", "authority.wal"),
  });
}

export function createSyntheticGateway(
  environment: SyntheticGatewayEnvironment,
  input: Readonly<{
    faults?: GatewayMutationFaults;
    fixtureMode?: "malformed_submit" | "partition_after_submit";
    mode?: "production" | "synthetic_research";
    version?: string;
  }> = {},
) {
  const binaryDigest = createHash("sha256")
    .update(readFileSync(process.execPath))
    .digest("hex");
  return createSchedulerMutationGateway({
    acknowledgementKey,
    authorityId: "gateway-1",
    credential: {
      fixedExecutableArguments: [
        fixturePath,
        "--fixture-version",
        input.version ?? "0.26.2",
        ...(input.fixtureMode === undefined
          ? []
          : ["--fixture-mode", input.fixtureMode]),
      ],
      hyperQueueExecutable: process.execPath,
      mutationServerDirectory: environment.schedulerDirectory,
    },
    ...(input.faults === undefined ? {} : { faults: input.faults }),
    mode: input.mode ?? "synthetic_research",
    nowMs: () => nowMs,
    release: {
      exactVersion: "0.26.2",
      expectedBinarySha256: binaryDigest,
      limits: { maxOutputBytes: 128 * 1024, timeoutMs: 5_000 },
      shimExecutable: "/opt/workload-funnel/bin/wf-hq-shim",
    },
    trustedInstallKeys: new Map([["issuer-1", issuerKey]]),
    walCapacity: 1_000,
    walPath: environment.walPath,
  });
}

export function scope(
  effectKind: "dispatch_submit" | "dispatch_cancel",
  dispatchId = "dispatch-1",
): SchedulerMutationScope {
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    dispatchId,
    effectKind,
    executionGeneration: "generation-1",
    namespaceId: "test://phase7",
    schedulerInstanceId: "scheduler-1",
  });
}

export function schedulerFence(
  effectKind: "dispatch_submit" | "dispatch_cancel",
  desiredVersion = 1,
  overrides: Partial<MutationFence> = {},
): MutationFence {
  const start =
    effectKind === "dispatch_submit"
      ? { issuedStartRevocationRevision: 0, startFence: "start-fence-1" }
      : {};
  return Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: effectKind,
    effectScopeKey: "scheduler-dispatch:dispatch-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: desiredVersion,
    namespaceId: "test://phase7",
    namespaceWriterEpoch: 1,
    notAfter: nowMs + 60_000,
    notBefore: nowMs - 1_000,
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: effectKind,
    schemaVersion: 1,
    supersessionKey: "dispatch:dispatch-1",
    ...start,
    ...overrides,
  });
}

async function installFence(
  gateway: ReturnType<typeof createSyntheticGateway>,
  targetScope: SchedulerMutationScope,
  fence: MutationFence,
  expectedPriorFingerprint: string | null,
  suffix: string,
  reopen: boolean,
): Promise<SignedSchedulerFenceInstallAcknowledgement> {
  await gateway.closeAndDrain({
    authorityId: "gateway-1",
    closeOperationId: `close-${suffix}`,
    scope: targetScope,
  });
  const install = signSchedulerFenceInstall(
    Object.freeze({
      authorityId: "gateway-1",
      expectedPriorFingerprint,
      installOperationId: `install-${suffix}`,
      issuedAtMs: nowMs - 1,
      issuerKeyId: "issuer-1",
      mutationFence: fence,
      mutationFenceFingerprint: fingerprintMutationFence(fence),
      notAfterMs: nowMs + 60_000,
      protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
      reason:
        fence.issuedStartRevocationRevision !== undefined &&
        fence.issuedStartRevocationRevision > 0
          ? "attempt_revocation"
          : "desired_effect_supersession",
      scope: targetScope,
    }),
    issuerKey,
  );
  const acknowledgement = await gateway.install(install);
  if (reopen)
    await gateway.reopen({
      acknowledgement,
      reopenOperationId: `reopen-${suffix}`,
    });
  return acknowledgement;
}

export function installAndOpen(
  gateway: ReturnType<typeof createSyntheticGateway>,
  targetScope: SchedulerMutationScope,
  fence: MutationFence,
  expectedPriorFingerprint: string | null = null,
  suffix = "1",
): Promise<SignedSchedulerFenceInstallAcknowledgement> {
  return installFence(
    gateway,
    targetScope,
    fence,
    expectedPriorFingerprint,
    suffix,
    true,
  );
}

export function installAndKeepClosed(
  gateway: ReturnType<typeof createSyntheticGateway>,
  targetScope: SchedulerMutationScope,
  fence: MutationFence,
  expectedPriorFingerprint: string | null,
  suffix: string,
): Promise<SignedSchedulerFenceInstallAcknowledgement> {
  return installFence(
    gateway,
    targetScope,
    fence,
    expectedPriorFingerprint,
    suffix,
    false,
  );
}

export function submitRequest(
  targetScope: SchedulerMutationScope,
  fence: MutationFence,
  acknowledgement: SignedSchedulerFenceInstallAcknowledgement,
  operationId = "submit-operation-1",
): MutateHyperQueueRequest {
  return Object.freeze({
    acknowledgedInstall: acknowledgement,
    mutationFence: fence,
    mutationFenceFingerprint: fingerprintMutationFence(fence),
    operationId,
    payload: Object.freeze({
      dispatchId: targetScope.dispatchId,
      jobName: "wf-dispatch-1",
      kind: "submit",
      mappingFingerprint: "mapping-fingerprint-1",
      requestedCpuCount: 1,
      requiredCustomResources: Object.freeze({ gpu: 1 }),
      restartPolicy: "never",
      shimInvocationBase64: Buffer.from("{}", "utf8").toString("base64url"),
    }),
    protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
    scope: targetScope,
  });
}

export function syntheticState(environment: SyntheticGatewayEnvironment) {
  return JSON.parse(readFileSync(environment.statePath, "utf8")) as {
    readonly jobs: Readonly<Record<string, unknown>>;
    readonly mutationCalls: number;
    readonly serverEpoch: number;
    readonly submissions: Readonly<
      Record<
        string,
        Readonly<{
          requestedCpuCount: number;
          requiredCustomResources: Readonly<Record<string, number>>;
          restartPolicy: string;
        }>
      >
    >;
  };
}

export async function executeSyntheticRead(
  environment: SyntheticGatewayEnvironment,
  args: readonly string[],
): Promise<string> {
  const result = await executeFile(
    process.execPath,
    [
      fixturePath,
      "--fixture-version",
      "0.26.2",
      "--server-dir",
      environment.schedulerDirectory,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 128 * 1024, timeout: 5_000 },
  );
  return result.stdout;
}

export function unusedShimInvocation(): SchedulerShimInvocation {
  const fence: MutationFence = Object.freeze({
    allocationId: "allocation-1",
    attemptId: "attempt-1",
    clusterIncarnation: "cluster-1",
    clusterIncarnationVersion: 1,
    desiredEffect: "process_start",
    effectScopeKey: "process:allocation-1",
    executionGeneration: "generation-1",
    expectedDesiredVersion: 1,
    issuedStartRevocationRevision: 0,
    namespaceId: "test://phase7",
    namespaceWriterEpoch: 1,
    nodeBootEpoch: 1,
    nodeId: "node-1",
    operationGateRevision: 1,
    ownerFence: 1,
    requiredGate: "process_start",
    schemaVersion: 1,
    startFence: "start-fence-1",
    supersessionKey: "process:allocation-1",
  });
  const ticket = Object.freeze<SignedExecutionTicket>({
    claims: {
      allocation: {
        allocationId: "allocation-1",
        attemptId: "attempt-1",
        executionGeneration: "generation-1",
        ownerFence: 1,
        ownerId: "owner-1",
      },
      attempt: {
        attemptId: "attempt-1",
        executionGeneration: "generation-1",
        startFence: "start-fence-1",
        startRevocationRevision: 0,
      },
      cluster: { incarnationId: "cluster-1", version: 1 },
      expiresAtMs: nowMs + 60_000,
      gate: { effect: "process_start", open: true, revision: 1 },
      issuedAtMs: nowMs - 1,
      issuerKeyId: "issuer-1",
      mutationFence: fence,
      mutationFenceFingerprint: fingerprintMutationFence(fence),
      namespace: {
        namespaceId: "test://phase7",
        writerEpoch: 1,
        writerId: "writer-1",
      },
      node: { bootEpoch: 1, bootId: "boot-1", nodeId: "node-1" },
      nonce: "nonce-1",
      operationId: "process-start-1",
      partitionPolicy: "terminate_after_grace",
      profileId: "synthetic-process-tree-v1",
      sandboxProfileDigest: "a".repeat(64),
      schemaVersion: "phase4c.execution-ticket.v1",
      ticketId: "ticket-1",
    },
    signatureBase64Url: "synthetic-signature",
  });

  return Object.freeze({
    dispatchId: "dispatch-1",
    mappingFingerprint: "mapping-fingerprint-1",
    protocolVersion: "phase7.scheduler-shim.v1",
    ticket,
  });
}
