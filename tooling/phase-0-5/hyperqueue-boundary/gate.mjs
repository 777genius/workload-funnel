import { evidence, pass, runCommand, unsupported } from "../shared.mjs";

export const researchPin = "0.26.2";

export function reconcileHyperQueueObservation(observation) {
  switch (observation.kind) {
    case "submit_timeout":
      return observation.operationLookup === "unique"
        ? { dispatchId: observation.dispatchId, status: "accepted" }
        : { status: "reconciliation_required" };
    case "server_restart":
      return observation.operationLookup === "unique"
        ? { dispatchId: observation.dispatchId, status: "accepted" }
        : { status: "unknown" };
    case "worker_loss":
      return { status: "unknown" };
    case "cancel_ack":
      return { status: "cancellation_observed" };
    case "lookup_absent":
      return observation.completeHistory
        ? { status: "proven_absent" }
        : { status: "unknown" };
    case "journal_pruned":
      return { status: "reconciliation_required" };
    case "malformed_output":
      return { status: "reconciliation_required" };
  }
  throw new Error("Unrecognized HyperQueue observation");
}

export function decideHyperQueueBoundary(facts) {
  const observations = [
    evidence(
      "hyperqueue.cli-present",
      facts.cliPresent,
      String(facts.cliPresent),
    ),
    evidence(
      "hyperqueue.exact-version",
      facts.version === researchPin,
      facts.version,
    ),
    evidence(
      "hyperqueue.operation-lookup",
      facts.uniqueOperationLookup,
      String(facts.uniqueOperationLookup),
    ),
    evidence(
      "hyperqueue.failure-matrix",
      facts.failureMatrixPassed,
      String(facts.failureMatrixPassed),
    ),
  ];
  if (
    facts.cliPresent &&
    facts.version === researchPin &&
    facts.uniqueOperationLookup &&
    facts.failureMatrixPassed
  ) {
    return pass({
      capability: "hyperqueue_ambiguous_submit_reconciliation",
      evidence: observations,
      gateId: "pinned_hyperqueue_cli_boundary",
      invariantIds: [
        "WF-INV-005",
        "WF-INV-012",
        "WF-INV-015",
        "WF-INV-031",
        "WF-INV-037",
      ],
    });
  }
  return unsupported({
    capability: "hyperqueue_ambiguous_submit_reconciliation",
    evidence: observations,
    gateId: "pinned_hyperqueue_cli_boundary",
    invariantIds: [
      "WF-INV-005",
      "WF-INV-012",
      "WF-INV-015",
      "WF-INV-031",
      "WF-INV-037",
    ],
    reasonCode: "hyperqueue_ambiguous_submit_reconciliation_unsupported",
    requiredHostEvidence: [
      `Run the exact research pin hq ${researchPin} against a disposable isolated server and worker; record binary digest and version output.`,
      "Route the sole mutation credential through the final-boundary harness and serialize the complete operation identity with each CLI call.",
      "Capture submit timeout, server restart, worker loss, cancel, exact lookup, journal prune, and malformed-output transcripts.",
      "Prove a timed-out submit is uniquely found by persisted operation identity; otherwise retain the replayable-only restriction.",
    ],
  });
}

export async function runHyperQueueBoundaryGate() {
  const version = await runCommand("hq", ["--version"]);
  const parsed =
    version.stdout.match(/(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/)?.[1] ??
    "unavailable";
  return decideHyperQueueBoundary({
    cliPresent: version.code === 0,
    failureMatrixPassed: false,
    uniqueOperationLookup: false,
    version: parsed,
  });
}
