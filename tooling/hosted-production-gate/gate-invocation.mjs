import { chmod, copyFile, readFile, writeFile } from "node:fs/promises";

import {
  DISPOSABLE_HOST_ATTESTATION,
  HOSTED_GATE_SCHEMA,
  PINNED_IMAGES,
} from "./constants.mjs";
import { HostedGateRefusal } from "./contract.mjs";
import {
  finishGateChild,
  planGateChild,
  recoverGateChild,
} from "./gate-child-state.mjs";
import { verifyInvocationCustody } from "./invocation-custody.mjs";
import { readHostState } from "./host-state.mjs";
import { writeJsonAtomically } from "./review-manifest.mjs";
import { runCommand } from "./process-runner.mjs";

export const INVOCATION_TIMEOUT_MS = Object.freeze({
  "cleanup-1": 20 * 60_000,
  "cleanup-2": 20 * 60_000,
  gate: 90 * 60_000,
});

function failureCode(error) {
  return error instanceof Error
    ? error.message
    : "hosted_gate_invocation_failed";
}

export function gateArguments(state, operation) {
  const { context, executables, hqArchive, loopDevice, manifest, reviewRoot } =
    state;
  if (
    state.phase !== "prepared" ||
    !new Set(["run", "recover-cleanup"]).has(operation) ||
    typeof reviewRoot !== "string" ||
    typeof loopDevice !== "string" ||
    typeof manifest?.path !== "string" ||
    typeof manifest?.sha256 !== "string"
  )
    throw new HostedGateRefusal("host_state_gate_inputs_incomplete");
  return Object.freeze([
    `${reviewRoot}/tooling/production-gate/run.mjs`,
    "--operation",
    operation,
    "--attestation",
    DISPOSABLE_HOST_ATTESTATION,
    "--review-manifest",
    manifest.path,
    "--review-manifest-sha256",
    manifest.sha256,
    "--run-id",
    context.runId,
    "--sandbox-root",
    context.sandboxRoot,
    "--evidence-path",
    `${context.sandboxRoot}/evidence.json`,
    "--docker-executable",
    executables.docker,
    "--psql-executable",
    executables.psql,
    "--project-quota-helper",
    executables.projectQuotaHelper,
    "--aws-executable",
    executables.aws,
    "--id-executable",
    executables.id,
    "--node-executable",
    executables.node,
    "--systemctl-executable",
    executables.systemctl,
    "--systemd-analyze-executable",
    executables.systemdAnalyze,
    "--systemd-run-executable",
    executables.systemdRun,
    "--io-device",
    loopDevice,
    "--hq-archive",
    hqArchive,
    "--hq-binary",
    executables.hq,
    "--azurite-image",
    PINNED_IMAGES.azuriteFixture,
    "--postgres-image",
    PINNED_IMAGES.postgresFixture,
    "--object-image",
    PINNED_IMAGES.objectFixture,
    "--object-client-image",
    PINNED_IMAGES.objectClient,
  ]);
}

async function immutableCopy(source, destination) {
  await copyFile(source, destination);
  await chmod(destination, 0o444);
}

export async function invokeProductionGate(context, invocation) {
  const operation = invocation === "gate" ? "run" : "recover-cleanup";
  const logName = `${invocation}.log`;
  const statusName = `${invocation}-status.json`;
  const startedAt = new Date().toISOString();
  let exitCode = 2;
  let reason = null;
  try {
    let state = await readHostState(context);
    for (const predecessor of invocation === "cleanup-1"
      ? ["gate"]
      : invocation === "cleanup-2"
        ? ["cleanup-1", "gate"]
        : [])
      await recoverGateChild(state, predecessor);
    state = await readHostState(context);
    await verifyInvocationCustody(state);
    const child = await planGateChild(state, invocation);
    const childEntry = `${state.reviewRoot}/tooling/hosted-production-gate/gate-child.mjs`;
    const runtimeSeconds = Math.floor(
      (INVOCATION_TIMEOUT_MS[invocation] - 30_000) / 1000,
    );
    const result = await runCommand(
      state.executables.systemdRun,
      [
        "--quiet",
        "--collect",
        "--wait",
        "--pipe",
        `--description=workload-funnel-hosted-gate:${child.marker}`,
        `--unit=${child.unit}`,
        "--service-type=exec",
        "--property=KillMode=control-group",
        `--property=RuntimeMaxSec=${runtimeSeconds}s`,
        "--property=TimeoutStopSec=30s",
        "--setenv=HOME=/root",
        "--setenv=LANG=C.UTF-8",
        "--setenv=LC_ALL=C.UTF-8",
        "--setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "--setenv=TZ=UTC",
        `--setenv=GITHUB_WORKSPACE=${context.workspace}`,
        `--setenv=GITHUB_SHA=${context.commit}`,
        `--setenv=GITHUB_RUN_ID=${context.runNumber}`,
        `--setenv=GITHUB_RUN_ATTEMPT=${context.runAttempt}`,
        `--setenv=RUNNER_TEMP=${context.runnerTemp}`,
        `--setenv=WF_HOSTED_GATE_CHILD_MARKER=${child.marker}`,
        state.executables.node,
        childEntry,
        invocation,
      ],
      {
        maxOutputBytes: 16 * 1024 * 1024,
        timeoutMs: INVOCATION_TIMEOUT_MS[invocation],
      },
    );
    exitCode = result.code ?? 2;
    reason = result.errorCode ?? null;
    state = await readHostState(context);
    const observedChild = state.gateInvocations.find(
      (item) => item.id === invocation,
    );
    if (
      observedChild?.status === "started" &&
      Number.isSafeInteger(result.code)
    )
      await finishGateChild(state, invocation, {
        exitCode,
        outcome: "completed",
      });
    else if (observedChild?.status !== "finished")
      throw new HostedGateRefusal("gate_child_start_unproven");
    await writeFile(
      `${context.artifactRoot}/${logName}`,
      `${result.stdout}${result.stderr}`,
      { flag: "wx", mode: 0o444 },
    );
    const output =
      operation === "run"
        ? `${context.sandboxRoot}/evidence.json`
        : `${context.sandboxRoot}/cleanup-recovery.json`;
    if (
      await readFile(output)
        .then(() => true)
        .catch(() => false)
    )
      await immutableCopy(
        output,
        `${context.artifactRoot}/${operation === "run" ? "evidence.json" : `${invocation}.json`}`,
      );
    if (operation === "run") {
      const ledger = `${context.sandboxRoot}/cleanup-ledger.json`;
      if (
        await readFile(ledger)
          .then(() => true)
          .catch(() => false)
      )
        await immutableCopy(
          ledger,
          `${context.artifactRoot}/cleanup-ledger.json`,
        );
    }
  } catch (error) {
    reason = failureCode(error);
    await writeFile(`${context.artifactRoot}/${logName}`, `${reason}\n`, {
      flag: "wx",
      mode: 0o444,
    }).catch(() => undefined);
  }
  await writeJsonAtomically(`${context.artifactRoot}/${statusName}`, {
    exitCode,
    finishedAt: new Date().toISOString(),
    invocation,
    operation,
    reason,
    runId: context.runId,
    schemaVersion: HOSTED_GATE_SCHEMA,
    startedAt,
  });
  if (exitCode !== 0)
    throw new HostedGateRefusal(`${invocation}_failed_closed`);
  return exitCode;
}
