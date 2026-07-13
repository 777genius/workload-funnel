import { describe, expect, it } from "vitest";

import { createResultAccessClient } from "@workload-funnel/client-sdk/result-access";
import { createWorkloadSubmissionClient } from "@workload-funnel/client-sdk/workload-submission";
import {
  assertGateOpen,
  closeOperationGates,
} from "@workload-funnel/workload-control/operation-gating";
import {
  prepareSyntheticMutationFence,
  type WorkloadSpec,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { createPhase5TestFixture } from "./phase5-test-fixture.js";

const spec: WorkloadSpec = Object.freeze({
  command: Object.freeze(["synthetic", "gate-proof"]),
  processProfile: "trusted-synthetic-v1",
  resources: Object.freeze({ cpuMillis: 100, memoryMiB: 64 }),
  resultFiles: Object.freeze([]),
  schemaVersion: 1,
  syntheticOutcome: "succeeded",
});

function options(key: string) {
  return Object.freeze({
    correlationId: `correlation-${key}`,
    idempotencyKey: key,
    requestId: `request-${key}`,
  });
}

describe("Phase 5 rollback operation freeze", () => {
  it("records legal-hold-blocked erasure idempotently without changing canonical identity", async () => {
    const fixture = createPhase5TestFixture();
    fixture.database.state.legalHoldSubjects.add("synthetic-principal");
    const results = createResultAccessClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const first = await results.requestErasure(
      "synthetic-principal",
      ["principal_references", "artifacts"],
      "legal hold check",
      options("held-erasure"),
    );
    const duplicate = await results.requestErasure(
      "synthetic-principal",
      ["principal_references", "artifacts"],
      "legal hold check",
      options("held-erasure"),
    );
    expect(first.state).toBe("pending_legal_hold");
    expect(duplicate.duplicate).toBe(true);
    expect(
      fixture.database.state.erasedSubjectPseudonyms.has("synthetic-principal"),
    ).toBe(false);
    await expect(
      results.requestErasure(
        "synthetic-principal",
        ["audit"],
        "changed request",
        options("held-erasure"),
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("freezes process starts, automatic retries, and result deletion while observation and cancellation stay available", async () => {
    const fixture = createPhase5TestFixture();
    const submission = createWorkloadSubmissionClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const results = createResultAccessClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const completed = await submission.submit(spec, options("completed"));
    fixture.service.runUntilIdle();
    const terminal = fixture.service.status(completed.runId);
    const resultManifestId = terminal?.attempt.resultManifestId;
    if (resultManifestId === undefined) throw new Error("result_missing");
    const queued = await submission.submit(spec, options("queued"));
    const queuedStatus = fixture.service.status(queued.runId);
    if (queuedStatus === undefined) throw new Error("queued_status_missing");

    const current = fixture.database.state.gateSet;
    const fence = prepareSyntheticMutationFence({
      attempt: queuedStatus.attempt,
      desiredEffect: "artifact_delete",
      effectScopeKey: "rollback-gate-close",
      expectedDesiredVersion: 1,
      gateRevision: current.revision,
      namespaceId: current.namespaceId,
      requiredGate: "acceptance",
      supersessionKey: "rollback-gate-close",
    });
    fixture.database.state.gateSet = closeOperationGates({
      authorizationGate: "acceptance",
      current,
      expectedRevision: current.revision,
      gates: Object.freeze([
        "process_start",
        "automatic_retry",
        "result_delete",
      ]),
      mutationFence: fence,
    });

    expect(() => {
      assertGateOpen(fixture.database.state.gateSet, "automatic_retry");
    }).toThrow("automatic_retry");
    await expect(
      results.requestRetention(
        resultManifestId,
        "delete",
        "rollback freeze",
        options("blocked-delete"),
      ),
    ).rejects.toMatchObject({ code: "operation_gate_closed", status: 409 });
    expect(fixture.service.result(resultManifestId)?.retentionState).toBe(
      "active",
    );

    let startRejected = false;
    for (let index = 0; index < 12; index += 1) {
      try {
        fixture.service.step();
      } catch (error) {
        expect(error).toMatchObject({
          message: "Operation gate is closed: process_start",
        });
        startRejected = true;
        break;
      }
    }
    expect(startRejected).toBe(true);
    expect(
      [...fixture.database.state.executions.values()].some(
        (execution) => execution.attemptId === queued.attemptId,
      ),
    ).toBe(false);
    expect(() => {
      assertGateOpen(fixture.database.state.gateSet, "cancel");
    }).not.toThrow();
  });

  it("blocks an actual automatic allocation retry after rollback closes its gate", async () => {
    const fixture = createPhase5TestFixture();
    const submission = createWorkloadSubmissionClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const accepted = await submission.submit(spec, options("retry-freeze"));
    fixture.database.state.rejectNextAttachment = true;
    fixture.service.step();
    fixture.service.step();
    const rejected = fixture.service.status(accepted.runId);
    if (rejected === undefined) throw new Error("rejected_status_missing");
    expect(rejected.attempt.attachmentRejections).toBe(1);
    expect(rejected.attempt.state).toBe("queued");
    const allocationsBefore = fixture.database.state.allocations.size;

    const current = fixture.database.state.gateSet;
    const fence = prepareSyntheticMutationFence({
      attempt: rejected.attempt,
      desiredEffect: "artifact_delete",
      effectScopeKey: "rollback-retry-close",
      expectedDesiredVersion: 1,
      gateRevision: current.revision,
      namespaceId: current.namespaceId,
      requiredGate: "acceptance",
      supersessionKey: "rollback-retry-close",
    });
    fixture.database.state.gateSet = closeOperationGates({
      authorizationGate: "acceptance",
      current,
      expectedRevision: current.revision,
      gates: Object.freeze(["automatic_retry"]),
      mutationFence: fence,
    });

    expect(() => fixture.service.step()).toThrow(
      "Operation gate is closed: automatic_retry",
    );
    expect(fixture.database.state.allocations.size).toBe(allocationsBefore);
    expect(fixture.service.status(accepted.runId)?.attempt.state).toBe(
      "queued",
    );
  });
});
