import { describe, expect, it } from "vitest";

import { createCapacityObservationClient } from "@workload-funnel/client-sdk/capacity-observation";
import { createEventSubscriptionClient } from "@workload-funnel/client-sdk/event-subscription";
import { createResultAccessClient } from "@workload-funnel/client-sdk/result-access";
import { createWorkloadCancellationClient } from "@workload-funnel/client-sdk/workload-cancellation";
import { createWorkloadObservationClient } from "@workload-funnel/client-sdk/workload-observation";
import { createWorkloadSubmissionClient } from "@workload-funnel/client-sdk/workload-submission";
import { replaySyntheticErasureLedger } from "@workload-funnel/control-service/phase1-synthetic-runtime";
import type { WorkloadSpec } from "@workload-funnel/workload-control/workload-lifecycle";

import { createPhase5TestFixture } from "./phase5-test-fixture.js";

function spec(
  outcome: "succeeded" | "failed" | "canceled" = "succeeded",
): WorkloadSpec {
  return Object.freeze({
    command: Object.freeze(["synthetic", "phase5"]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis: 250, memoryMiB: 128 }),
    resultFiles: Object.freeze([
      Object.freeze({ content: "phase5-result", path: "result.txt" }),
    ]),
    schemaVersion: 1,
    syntheticOutcome: outcome,
  });
}

function mutation(idempotencyKey: string) {
  return Object.freeze({
    correlationId: `correlation-${idempotencyKey}`,
    idempotencyKey,
    requestId: `request-${idempotencyKey}`,
  });
}

describe("Phase 5 public API and stable SDK", () => {
  it("submits, observes, explains, streams, reads results, retains, erases, and audits through product flows", async () => {
    const fixture = createPhase5TestFixture();
    const submission = createWorkloadSubmissionClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const observation = createWorkloadObservationClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const capacity = createCapacityObservationClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const events = createEventSubscriptionClient<unknown>(
      fixture.transport,
      "synthetic-tenant",
    );
    const results = createResultAccessClient(
      fixture.transport,
      "synthetic-tenant",
    );

    const snapshot = await events.snapshot();
    expect(snapshot.contractVersion).toBe("workload-funnel.snapshot/v1");
    expect(snapshot.items).toEqual([]);
    const consumer = await events.registerConsumer(
      {
        consumerId: "sdk-consumer",
        cursor: snapshot.cursor,
        limits: Object.freeze({
          batchSize: 10,
          leaseDurationMs: 1000,
          maximumBufferedBytes: 100_000,
          maximumBufferedCount: 100,
          maximumLag: 100,
          replayHorizonMs: 10_000,
        }),
        snapshotWatermark: snapshot.snapshotWatermark,
      },
      mutation("register-consumer"),
    );
    expect(consumer.state).toBe("active");

    const accepted = await submission.submit(spec(), mutation("submit-1"));
    fixture.advance(100);
    const duplicate = await submission.submit(spec(), mutation("submit-1"));
    expect(duplicate).toEqual(accepted);
    expect((await observation.workload(accepted.runId)).run.state).toBe(
      "accepted",
    );
    expect((await observation.operation(accepted.operationId)).resourceId).toBe(
      accepted.runId,
    );
    expect((await observation.explanation(accepted.runId)).reason).toBe(
      "admissible",
    );
    expect((await capacity.observe()).snapshots[0]?.status).toBe("open");

    const page = await events.events(
      snapshot.cursor,
      snapshot.snapshotWatermark,
    );
    expect(page.events.map((event) => event.eventType)).toEqual([
      "WorkloadAccepted",
    ]);
    const offered = await events.consume("sdk-consumer");
    expect(offered.page.snapshotWatermark).toBe(snapshot.snapshotWatermark);
    const redelivered = await events.consume("sdk-consumer");
    expect(redelivered.page.events).toEqual(offered.page.events);
    await events.acknowledge(
      "sdk-consumer",
      offered.page.after,
      mutation("ack-consumer"),
    );
    expect((await events.consume("sdk-consumer")).page.events).toEqual([]);

    fixture.service.runUntilIdle();
    const terminal = await observation.workload(accepted.runId);
    expect(terminal.run.state).toBe("succeeded");
    const resultId = terminal.attempt.resultManifestId;
    expect(resultId).toBeDefined();
    if (resultId === undefined) throw new Error("result_missing");
    const result = await results.result(resultId);
    expect(result.manifest.entries[0]?.path).toBe("result.txt");

    const retention = await results.requestRetention(
      resultId,
      "delete",
      "synthetic retention",
      { ...mutation("retention-1"), expectedVersion: result.manifest.version },
    );
    expect(retention.state).toBe("accepted");
    expect(
      (
        await results.requestRetention(
          resultId,
          "delete",
          "synthetic retention",
          {
            ...mutation("retention-1"),
            correlationId: "retry-with-a-new-correlation",
            expectedVersion: result.manifest.version,
          },
        )
      ).duplicate,
    ).toBe(true);

    const erasure = await results.requestErasure(
      "synthetic-principal",
      ["principal_references", "audit"],
      "subject request",
      mutation("erasure-1"),
    );
    expect(erasure.state).toBe("completed");
    expect(fixture.database.state.audit.at(-1)?.actorId).not.toContain(
      "synthetic-principal",
    );
    const audit = await fixture.transport.request<{
      records: readonly {
        actorId: string;
        reason: string;
        affectedResources: readonly string[];
      }[];
    }>({
      method: "GET",
      path: "/v1/audit",
      query: Object.freeze({ tenant: "synthetic-tenant" }),
    });
    expect(
      audit.records.some((record) => record.reason === "subject request"),
    ).toBe(true);
    expect(
      audit.records.every(
        (record) => !record.actorId.includes("synthetic-principal"),
      ),
    ).toBe(true);
    expect(JSON.stringify(audit.records)).not.toContain("synthetic-principal");
    const erasureLedger = fixture.database.erasureLedger.records();
    expect(erasureLedger).toHaveLength(1);
    const erasureRecord = erasureLedger[0];
    if (erasureRecord === undefined)
      throw new Error("erasure_ledger_record_missing");
    expect(fixture.database.erasureLedger.verify(erasureRecord)).toBe(true);
    expect(JSON.stringify(erasureLedger)).not.toContain("synthetic-principal");

    const restored = fixture.database.state.workloadById.get(
      accepted.workloadId,
    );
    if (restored === undefined) throw new Error("workload_restore_missing");
    fixture.database.state.workloadById.set(
      accepted.workloadId,
      Object.freeze({ ...restored, principalId: "synthetic-principal" }),
    );
    fixture.database.state.lifecycleErasureByOperation.delete(
      erasure.operationId,
    );
    fixture.database.state.erasedSubjectPseudonyms.clear();
    replaySyntheticErasureLedger(fixture.service, fixture.database);
    expect(
      fixture.database.state.workloadById.get(accepted.workloadId)?.principalId,
    ).toMatch(/^erased-/u);
  });

  it("cancels idempotently without treating requested cancellation as observed terminal state", async () => {
    const fixture = createPhase5TestFixture();
    const submission = createWorkloadSubmissionClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const observation = createWorkloadObservationClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const cancellation = createWorkloadCancellationClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const accepted = await submission.submit(spec(), mutation("cancel-submit"));
    const first = await cancellation.cancel(
      accepted.runId,
      "operator request",
      mutation("cancel-1"),
    );
    const duplicate = await cancellation.cancel(
      accepted.runId,
      "operator request",
      mutation("cancel-1"),
    );
    expect(duplicate).toEqual(first);
    await expect(
      cancellation.cancel(
        accepted.runId,
        "conflicting reason",
        mutation("cancel-1"),
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict", status: 409 });
    const observed = await observation.workload(accepted.runId);
    expect(observed.run.state).toBe("accepted");
    expect(observed.run.cancellationDesired).toBe("requested");
  });

  it("expires bounded slow consumers through snapshot-bootstrap semantics", async () => {
    const fixture = createPhase5TestFixture();
    const events = createEventSubscriptionClient<unknown>(
      fixture.transport,
      "synthetic-tenant",
    );
    const submission = createWorkloadSubmissionClient(
      fixture.transport,
      "synthetic-tenant",
    );
    const snapshot = await events.snapshot();
    await events.registerConsumer(
      {
        consumerId: "bounded-consumer",
        cursor: snapshot.cursor,
        limits: Object.freeze({
          batchSize: 1,
          leaseDurationMs: 1000,
          maximumBufferedBytes: 100_000,
          maximumBufferedCount: 10,
          maximumLag: 0,
          replayHorizonMs: 10_000,
        }),
        snapshotWatermark: snapshot.snapshotWatermark,
      },
      mutation("bounded-register"),
    );
    await submission.submit(spec(), mutation("bounded-submit"));

    await expect(events.consume("bounded-consumer")).rejects.toMatchObject({
      code: "consumer_bootstrap_required",
      status: 410,
    });
  });
});
