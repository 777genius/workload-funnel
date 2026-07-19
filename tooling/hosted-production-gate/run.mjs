import { lstat, realpath } from "node:fs/promises";

import {
  assertFinalOutcome,
  packageArtifacts,
  verifyZeroResidue,
} from "./artifacts.mjs";
import { hostedContext, HostedGateRefusal } from "./contract.mjs";
import { invokeProductionGate } from "./gate-invocation.mjs";
import { cleanupHost } from "./host-cleanup.mjs";
import { initializeArtifacts, prepareHost } from "./host-setup.mjs";
import { writeJsonAtomically } from "./review-manifest.mjs";

const command = process.argv[2];
const allowed = new Set([
  "assert",
  "cleanup-1",
  "cleanup-2",
  "gate",
  "initialize",
  "package",
  "prepare",
  "residue",
  "teardown",
]);

function reason(error) {
  return error instanceof Error && /^[a-z0-9_:-]{1,160}$/u.test(error.message)
    ? error.message
    : "hosted_production_gate_command_failed";
}

async function assertArtifactRoot(context, rootRequired) {
  const identity = await lstat(context.artifactRoot);
  if (
    (await realpath(context.artifactRoot)) !== context.artifactRoot ||
    !identity.isDirectory() ||
    identity.isSymbolicLink() ||
    (identity.mode & 0o022) !== 0 ||
    (rootRequired &&
      (!Number.isSafeInteger(Number(process.env.SUDO_UID)) ||
        identity.uid !== Number(process.env.SUDO_UID)))
  )
    throw new HostedGateRefusal("artifact_root_identity_untrusted");
}

async function main() {
  if (!allowed.has(command) || process.argv.length !== 3)
    throw new HostedGateRefusal("hosted_gate_command_invalid");
  const context = hostedContext(process.env);
  if (command === "initialize") {
    if (process.getuid?.() === 0)
      throw new HostedGateRefusal(
        "artifact_initialization_must_be_unprivileged",
      );
    await initializeArtifacts(context);
    return;
  }
  const rootRequired = command !== "assert";
  if (rootRequired && process.getuid?.() !== 0)
    throw new HostedGateRefusal("hosted_gate_root_required");
  await assertArtifactRoot(context, rootRequired);
  if (command === "prepare") await prepareHost(context);
  else if (command === "gate" || command.startsWith("cleanup-"))
    await invokeProductionGate(context, command);
  else if (command === "teardown") await cleanupHost(context);
  else if (command === "residue") await verifyZeroResidue(context);
  else if (command === "package") await packageArtifacts(context);
  else await assertFinalOutcome(context);
}

try {
  await main();
} catch (error) {
  const value = reason(error);
  if (command === "teardown") {
    const context = (() => {
      try {
        return hostedContext(process.env);
      } catch {
        return undefined;
      }
    })();
    if (context !== undefined) {
      const cleanupPath = `${context.artifactRoot}/host-cleanup.json`;
      const alreadyWritten = await lstat(cleanupPath)
        .then(() => true)
        .catch((failure) => {
          if (failure?.code === "ENOENT") return false;
          throw failure;
        });
      if (!alreadyWritten)
        await writeJsonAtomically(cleanupPath, {
          certain: false,
          reason: value,
          runId: context.runId,
          schemaVersion: "workload-funnel.hosted-production-gate.v1",
        }).catch(() => undefined);
    }
  }
  process.stderr.write(`${value}\n`);
  process.exitCode = 1;
}
