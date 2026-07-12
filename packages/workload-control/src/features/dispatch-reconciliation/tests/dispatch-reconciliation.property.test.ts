import { describe, expect, it } from "vitest";

import {
  InvalidDispatchTransitionError,
  reconcileUnknownDispatch,
  transitionDispatch,
  type Dispatch,
  type DispatchEvidence,
} from "../index.js";

function dispatch(observed: Dispatch["observed"]): Dispatch {
  return Object.freeze({
    adapter: "dispatcher-local",
    allocationId: "allocation-1",
    desired: "submit",
    dispatchId: "dispatch-1",
    executionGeneration: "generation-1",
    mutationFence: Object.freeze({
      allocationId: "allocation-1",
      attemptId: "attempt-1",
      clusterIncarnation: "cluster-1",
      clusterIncarnationVersion: 1,
      desiredEffect: "dispatch_submit",
      effectScopeKey: "dispatch:dispatch-1",
      executionGeneration: "generation-1",
      expectedDesiredVersion: 1,
      issuedStartRevocationRevision: 0,
      namespaceId: "test://phase2",
      namespaceWriterEpoch: 1,
      operationGateRevision: 1,
      ownerFence: 1,
      requiredGate: "dispatch_submit",
      schemaVersion: 1,
      startFence: "start-fence-1",
      supersessionKey: "dispatch:dispatch-1",
    } as const),
    observed,
    operationId: "submit-1",
    version: 1,
  });
}

function evidence(
  kind: DispatchEvidence["kind"],
  observed: DispatchEvidence["observed"],
  complete = true,
): DispatchEvidence {
  return Object.freeze({
    complete,
    digest: `${kind}:${observed}`,
    kind,
    observed,
    source: kind,
    sourceEpoch: 1,
    sourceSequence: 1,
  });
}

describe("Phase 2 Dispatch state and ordered unknown reconciliation", () => {
  it("accepts direct fast terminal observations without fabricated intermediate states", () => {
    for (const state of ["submitting", "accepted", "starting"] as const) {
      expect(transitionDispatch(dispatch(state), "terminal")).toMatchObject({
        observed: "terminal",
        version: 2,
      });
    }
  });

  it("reconciles complete evidence to every normative unknown target", () => {
    const cases: readonly [
      DispatchEvidence["kind"],
      DispatchEvidence["observed"],
    ][] = [
      ["submit_receipt", "accepted"],
      ["node_process", "starting"],
      ["node_process", "running"],
      ["execution_terminal", "terminal"],
      ["absence_proof", "absent"],
      ["exhausted", "reconciliation_required"],
    ];
    for (const [kind, observed] of cases) {
      expect(
        reconcileUnknownDispatch(dispatch("unknown"), [
          evidence(kind, observed),
        ]),
      ).toMatchObject({ observed });
    }
  });

  it("uses fixed proof priority rather than receive order", () => {
    const terminal = evidence("execution_terminal", "terminal");
    const scheduler = evidence("scheduler_event", "running");
    expect(
      reconcileUnknownDispatch(dispatch("unknown"), [scheduler, terminal]),
    ).toMatchObject({
      lastEvidence: terminal,
      observed: "terminal",
    });
  });

  it("rejects incomplete absence proof and conflicting equal positions", () => {
    expect(
      reconcileUnknownDispatch(dispatch("unknown"), [
        evidence("absence_proof", "absent", false),
      ]).observed,
    ).toBe("reconciliation_required");
    const first = evidence("scheduler_event", "accepted");
    const conflict: DispatchEvidence = Object.freeze({
      ...first,
      digest: "different",
      observed: "running",
    });
    expect(
      reconcileUnknownDispatch(dispatch("unknown"), [first, conflict]).observed,
    ).toBe("reconciliation_required");
  });

  it("never turns unknown into suppressed merely from cancellation desire", () => {
    expect(() => transitionDispatch(dispatch("unknown"), "suppressed")).toThrow(
      InvalidDispatchTransitionError,
    );
  });
});
