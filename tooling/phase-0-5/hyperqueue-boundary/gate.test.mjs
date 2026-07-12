import { describe, expect, it } from "vitest";

import {
  decideHyperQueueBoundary,
  reconcileHyperQueueObservation,
  researchPin,
} from "./gate.mjs";

describe("Phase 0.5 pinned HyperQueue CLI boundary", () => {
  it.each([
    [
      "submit timeout without unique lookup",
      { kind: "submit_timeout", operationLookup: "unavailable" },
      "reconciliation_required",
    ],
    [
      "server restart",
      { kind: "server_restart", operationLookup: "unavailable" },
      "unknown",
    ],
    ["worker loss", { kind: "worker_loss" }, "unknown"],
    ["cancellation", { kind: "cancel_ack" }, "cancellation_observed"],
    [
      "incomplete lookup",
      { completeHistory: false, kind: "lookup_absent" },
      "unknown",
    ],
    ["journal prune", { kind: "journal_pruned" }, "reconciliation_required"],
    [
      "malformed output",
      { kind: "malformed_output" },
      "reconciliation_required",
    ],
  ])("reconciles %s fail closed", (_name, observation, status) => {
    expect(reconcileHyperQueueObservation(observation)).toMatchObject({
      status,
    });
  });

  it("can accept an ambiguous submit only with a unique operation lookup", () => {
    expect(
      reconcileHyperQueueObservation({
        dispatchId: "hq-job-1",
        kind: "submit_timeout",
        operationLookup: "unique",
      }),
    ).toEqual({ dispatchId: "hq-job-1", status: "accepted" });
  });

  it("does not turn transcript mocks into a host capability pass", () => {
    expect(
      decideHyperQueueBoundary({
        cliPresent: false,
        failureMatrixPassed: true,
        uniqueOperationLookup: true,
        version: researchPin,
      }),
    ).toMatchObject({
      productionGate: "closed",
      reasonCode: "hyperqueue_ambiguous_submit_reconciliation_unsupported",
      status: "unsupported",
    });
  });
});
