import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function commandExists(command) {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (directory.length === 0) continue;
    try {
      await access(`${directory}/${command}`, constants.X_OK);
      return true;
    } catch {
      // Continue through the fixed executable search path.
    }
  }
  return false;
}

export async function readText(path) {
  return readFile(path, "utf8").catch(() => undefined);
}

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
      ...options,
    });
    return { code: 0, stderr: result.stderr, stdout: result.stdout };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stderr: String(error.stderr ?? error.message),
      stdout: String(error.stdout ?? ""),
    };
  }
}

export function pass({ capability, evidence, gateId, invariantIds }) {
  return freezeDecision({
    capability,
    evidence,
    gateId,
    invariantIds,
    productionGate: "closed",
    status: "pass",
  });
}

export function unsupported({
  capability,
  evidence,
  gateId,
  invariantIds,
  reasonCode,
  requiredHostEvidence,
}) {
  return freezeDecision({
    capability,
    evidence,
    gateId,
    invariantIds,
    productionGate: "closed",
    reasonCode,
    requiredHostEvidence,
    status: "unsupported",
  });
}

function freezeDecision(decision) {
  for (const item of decision.evidence) Object.freeze(item);
  Object.freeze(decision.evidence);
  Object.freeze(decision.invariantIds);
  if (decision.requiredHostEvidence !== undefined) {
    Object.freeze(decision.requiredHostEvidence);
  }
  return Object.freeze(decision);
}

export function evidence(id, outcome, detail) {
  return { detail, id, outcome };
}

export function assertDecision(decision) {
  const statuses = new Set(["pass", "unsupported"]);
  if (
    decision.productionGate !== "closed" ||
    !statuses.has(decision.status) ||
    !Array.isArray(decision.evidence) ||
    decision.evidence.length === 0 ||
    !Array.isArray(decision.invariantIds) ||
    decision.invariantIds.length === 0
  ) {
    throw new Error(`Invalid feasibility decision for ${decision.gateId}`);
  }
  if (
    decision.status === "pass" &&
    decision.evidence.some((item) => item.outcome !== true)
  ) {
    throw new Error(`Passing decision contains failed evidence`);
  }
  if (
    decision.status === "unsupported" &&
    (typeof decision.reasonCode !== "string" ||
      decision.reasonCode.length === 0 ||
      !Array.isArray(decision.requiredHostEvidence) ||
      decision.requiredHostEvidence.length === 0)
  ) {
    throw new Error(`Unsupported decision lacks closure evidence`);
  }
  return decision;
}
