import { describe, expect, it } from "vitest";

import { createLocalDispatchCanceler } from "@workload-funnel/dispatcher-local/dispatch-cancellation";
import {
  createLocalDispatchSubmitter,
  type LocalDispatchFenceHighWatermark,
} from "@workload-funnel/dispatcher-local/dispatch-submission";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";
import type { Allocation } from "@workload-funnel/workload-control/allocation-leasing";
import {
  createDispatchSubmissionCommand,
  createLocalDispatcher,
  createSyntheticDispatchSubmissionCommand,
  type Dispatch,
  type DispatchMapping,
  type DispatchMutationAuthority,
  type DispatchStore,
} from "@workload-funnel/workload-control/dispatch-reconciliation";
import {
  createClosedGateSet,
  openSyntheticTestGates,
} from "@workload-funnel/workload-control/operation-gating";
import {
  prepareSyntheticMutationFence,
  type Attempt,
} from "@workload-funnel/workload-control/workload-lifecycle";

function allocation(): Allocation {
  return Object.freeze({
    allocationId: "allocation-0001",
    attemptId: "attempt-1",
    executionGeneration: "generation-1",
    leaseState: "unowned",
    nodeId: "synthetic-node-1",
    ownerFence: 0,
    resources: { cpuMillis: 100, memoryMiB: 128 },
    state: "active",
    version: 2,
  });
}

function attempt(): Attempt {
  return Object.freeze({
    attachmentRejections: 0,
    attemptId: "attempt-1",
    cancellationDesired: "none",
    executionGeneration: "generation-1",
    reservationRequestRevision: 1,
    runId: "run-1",
    startAuthorization: "authorized",
    startFence: "start-fence-1",
    startRevocationRevision: 0,
    state: "admitted",
    version: 1,
  });
}

function store(): DispatchStore {
  const dispatches = new Map<string, Dispatch>();
  const mappings = new Map<string, DispatchMapping>();
  return {
    create(dispatch, mapping) {
      dispatches.set(dispatch.allocationId, dispatch);
      mappings.set(dispatch.dispatchId, mapping);
      return dispatch;
    },
    getByAllocation: (allocationId) => dispatches.get(allocationId),
    mapping: (dispatchId) => mappings.get(dispatchId),
    save: (dispatch) => dispatches.set(dispatch.allocationId, dispatch),
  };
}

function cancellationFence(submissionFence: MutationFence): MutationFence {
  const {
    issuedStartRevocationRevision: _issuedStartRevocationRevision,
    startFence: _startFence,
    ...authority
  } = submissionFence;
  void _issuedStartRevocationRevision;
  void _startFence;
  return Object.freeze({
    ...authority,
    desiredEffect: "dispatch_cancel",
    expectedDesiredVersion: 2,
    requiredGate: "cancel",
  });
}

function authority(
  mutationFence: MutationFence,
  openGates: ReadonlySet<string>,
): DispatchMutationAuthority {
  return Object.freeze({
    allocationId: mutationFence.allocationId ?? "missing-allocation",
    attemptId: mutationFence.attemptId,
    clusterIncarnation: mutationFence.clusterIncarnation,
    clusterIncarnationVersion: mutationFence.clusterIncarnationVersion,
    desiredEffect: mutationFence.desiredEffect as
      | "dispatch_submit"
      | "dispatch_cancel",
    effectScopeKey: mutationFence.effectScopeKey,
    executionGeneration: mutationFence.executionGeneration,
    expectedDesiredVersion: mutationFence.expectedDesiredVersion,
    namespaceId: mutationFence.namespaceId,
    namespaceWriterEpoch: mutationFence.namespaceWriterEpoch,
    openGates,
    operationGateRevision: mutationFence.operationGateRevision,
    ownerFence: mutationFence.ownerFence ?? -1,
    requiredGate: mutationFence.requiredGate,
    ...(mutationFence.startFence === undefined
      ? {}
      : {
          startFence: mutationFence.startFence,
          startRevocationRevision: mutationFence.issuedStartRevocationRevision,
        }),
    supersessionKey: mutationFence.supersessionKey,
  });
}

describe("semantic MutationFence dispatch flow", () => {
  it("carries the canonical fence through the use case and ports to each final mutation", () => {
    const gates = openSyntheticTestGates(
      createClosedGateSet("test://phase1/fence-flow"),
      0,
    );
    const effects = new Map<string, "accepted" | "canceled">();
    const highWatermarks = new Map<string, LocalDispatchFenceHighWatermark>();
    const submitter = createLocalDispatchSubmitter(effects, highWatermarks);
    const dispatcher = createLocalDispatcher(
      store(),
      () => gates,
      submitter,
      createLocalDispatchCanceler(effects, highWatermarks),
    );
    const activeAllocation = allocation();
    const command = createDispatchSubmissionCommand(
      activeAllocation,
      prepareSyntheticMutationFence({
        allocation: {
          allocationId: activeAllocation.allocationId,
          ownerFence: activeAllocation.ownerFence,
        },
        attempt: attempt(),
        desiredEffect: "dispatch_submit",
        effectScopeKey: "dispatch:dispatch-0001",
        expectedDesiredVersion: 1,
        gateRevision: gates.revision,
        namespaceId: gates.namespaceId,
        requiredGate: "dispatch_submit",
        supersessionKey: "dispatch:dispatch-0001",
      }),
      true,
    );

    expect(dispatcher.submit(command)).toMatchObject({
      disposition: "accepted",
    });
    expect(effects.get("dispatch-0001")).toBe("accepted");
    expect(highWatermarks.get(command.mutationFence.effectScopeKey)).toEqual({
      desiredEffect: "dispatch_submit",
      desiredVersion: 1,
      fingerprint: fingerprintMutationFence(command.mutationFence),
    });

    expect(
      dispatcher.cancel({
        allocationId: command.allocation.allocationId,
        mutationFence: cancellationFence(command.mutationFence),
      }),
    ).toMatchObject({
      disposition: "cancel_requested",
    });
    expect(effects.get("dispatch-0001")).toBe("canceled");
    expect(
      highWatermarks.get(command.mutationFence.effectScopeKey),
    ).toMatchObject({
      desiredEffect: "dispatch_cancel",
      desiredVersion: 2,
    });

    expect(() =>
      submitter.submit({
        authority: authority(command.mutationFence, gates.open),
        dispatchId: "dispatch-0001",
        executionGeneration: "generation-1",
        mutationFence: command.mutationFence,
        operationId: "stale-replay",
      }),
    ).toThrow("local_dispatch_submission_stale_fence");
    expect(effects.get("dispatch-0001")).toBe("canceled");
  });

  it("does not invent a fenced cancellation effect for suppressed dispatch", () => {
    const gates = openSyntheticTestGates(
      createClosedGateSet("test://phase1/suppressed-flow"),
      0,
    );
    const effects = new Map<string, "accepted" | "canceled">();
    const highWatermarks = new Map<string, LocalDispatchFenceHighWatermark>();
    const dispatcher = createLocalDispatcher(
      store(),
      () => gates,
      createLocalDispatchSubmitter(effects, highWatermarks),
      createLocalDispatchCanceler(effects, highWatermarks),
    );
    const command = createSyntheticDispatchSubmissionCommand(
      allocation(),
      {
        authorized: false,
        startFence: "start-fence-1",
        startRevocationRevision: 1,
      },
      gates,
    );

    expect(dispatcher.submit(command)).toMatchObject({
      disposition: "suppressed",
    });
    expect(
      dispatcher.cancel({
        allocationId: command.allocation.allocationId,
        mutationFence: cancellationFence(command.mutationFence),
      }),
    ).toMatchObject({
      disposition: "cancel_requested",
    });
    expect(effects).toEqual(new Map());
    expect(highWatermarks).toEqual(new Map());
  });
});
