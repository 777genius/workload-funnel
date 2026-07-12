import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapacityUnavailableError } from "@workload-funnel/workload-control/allocation-leasing";
import {
  UnsafeArtifactPathError,
  createDisposableSynchronousArtifactWriter,
  createLocalFilesystemArtifactWriter,
} from "@workload-funnel/artifact-store-filesystem/verify-finalize";
import { createSyntheticArtifactFinalizeCommand } from "@workload-funnel/workload-control/result-management";
import { AuthenticationError } from "@workload-funnel/control-service/authentication";
import { createSyntheticHttpApi } from "@workload-funnel/control-service/transport-http";
import { createWorkloadApi } from "@workload-funnel/control-service/workload-controller";
import {
  ClosedOperationGateError,
  assertGateOpen,
  closeOperationGates,
  createClosedGateSet,
  openSyntheticTestGates,
} from "@workload-funnel/workload-control/operation-gating";
import type {
  TerminalOutcome,
  WorkloadSpec,
} from "@workload-funnel/workload-control/workload-lifecycle";
import { prepareSyntheticMutationFence } from "@workload-funnel/workload-control/workload-lifecycle";
import { describe, expect, it } from "vitest";

import {
  createPhase1SyntheticService,
  createSyntheticDatabase as createRawSyntheticDatabase,
  type SyntheticDatabaseProfile,
} from "../../phase1-synthetic-runtime/index.js";

const profiles: readonly SyntheticDatabaseProfile[] = ["postgres", "sqlite"];

function createSyntheticDatabase(profile: SyntheticDatabaseProfile) {
  return createRawSyntheticDatabase(
    profile,
    profile === "sqlite"
      ? createDisposableSynchronousArtifactWriter()
      : undefined,
  );
}

function spec(
  syntheticOutcome: TerminalOutcome,
  resultFiles: WorkloadSpec["resultFiles"] = [],
  cpuMillis = 500,
): WorkloadSpec {
  return Object.freeze({
    command: Object.freeze(["synthetic", syntheticOutcome]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis, memoryMiB: 256 }),
    resultFiles: Object.freeze(resultFiles),
    schemaVersion: 1,
    syntheticOutcome,
  });
}

describe.each(profiles)("Phase 1 %s synthetic profile", (profile) => {
  it.each([
    ["succeeded", []],
    ["failed", [{ content: "diagnostic\n", path: "logs/diagnostic.txt" }]],
    ["canceled", [{ content: "partial\n", path: "partial.txt" }]],
  ] as const)(
    "reaches terminal state %s with a complete manifest",
    async (outcome, files) => {
      const database = createSyntheticDatabase(profile);
      const service = createPhase1SyntheticService(database);
      const profileFiles = profile === "sqlite" ? files : [];
      const receipt = service.submit({
        idempotencyKey: `terminal-${outcome}`,
        spec: spec(outcome, profileFiles),
      });

      service.runUntilIdle();

      const status = service.status(receipt.runId);
      expect(status?.run.terminalOutcome).toBe(outcome);
      expect(status?.attempt.state).toBe(outcome);
      expect(status?.attempt.resultManifestId).toBe(
        `manifest-${receipt.attemptId.slice("attempt-".length)}`,
      );
      const manifest = database.state.manifests.get(
        status?.attempt.resultManifestId ?? "",
      );
      expect(manifest?.complete).toBe(true);
      expect(manifest?.entries).toHaveLength(profileFiles.length);
      for (const [index, entry] of (manifest?.entries ?? []).entries()) {
        expect(await readFile(new URL(entry.location), "utf8")).toBe(
          profileFiles[index]?.content,
        );
      }
      expect(service.capacity()).toEqual({
        reservedCpuMillis: 0,
        reservedMemoryMiB: 0,
      });
      expect(
        new Set([
          receipt.workloadId,
          receipt.runId,
          receipt.attemptId,
          status?.attempt.allocationId,
          status?.attempt.dispatchId,
          status?.attempt.executionId,
          status?.attempt.resultManifestId,
        ]).size,
      ).toBe(7);
    },
  );

  it("returns stable duplicate acceptance and operation receipts", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const command = { idempotencyKey: "same-submit", spec: spec("succeeded") };

    const first = service.submit(command);
    const duplicate = service.submit(command);

    expect(duplicate).toEqual(first);
    expect(database.state.workloadById).toHaveLength(1);
    expect(database.state.runById).toHaveLength(1);
    expect(database.state.attemptById).toHaveLength(1);
    expect(database.state.outbox).toHaveLength(1);
    expect(service.operationStatus(first.operationId)).toEqual({
      kind: "submit",
      operationId: first.operationId,
      resourceId: first.runId,
      status: "committed",
    });
    expect(() =>
      service.submit({ idempotencyKey: "same-submit", spec: spec("failed") }),
    ).toThrow("different WorkloadSpec");
    expect(database.state.queuedCount).toBe(1);
    service.runUntilIdle();
    expect(database.state.executions).toHaveLength(1);
  });

  it("refuses success when the attached manifest is not complete", () => {
    const database = createSyntheticDatabase(profile);
    let service = createPhase1SyntheticService(database);
    const receipt = service.submit({
      idempotencyKey: "incomplete-manifest",
      spec: spec("succeeded"),
    });
    for (let boundary = 0; boundary < 6; boundary += 1) service.step();
    const status = service.status(receipt.runId);
    const manifest = database.state.manifests.get(
      status?.attempt.resultManifestId ?? "",
    );
    if (manifest === undefined)
      throw new Error("Expected a finalized manifest");
    database.state.manifests.set(
      manifest.resultManifestId,
      Object.freeze({ ...manifest, complete: false }),
    );

    service = createPhase1SyntheticService(database);
    expect(() => service.step()).toThrow("complete manifest");
    expect(service.status(receipt.runId)?.attempt.state).toBe(
      "publishing_results",
    );
    expect(service.capacity().reservedCpuMillis).toBeGreaterThan(0);
  });

  it("fails closed instead of falling back when filesystem artifacts are unavailable", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const receipt = service.submit({
      idempotencyKey: "artifact-profile-isolation",
      spec: spec("succeeded", [
        { content: "profile artifact\n", path: "profile.txt" },
      ]),
    });

    if (profile === "postgres") {
      expect(() => {
        service.runUntilIdle();
      }).toThrow("No filesystem artifact provider is configured");
      expect(service.status(receipt.runId)?.attempt.state).toBe(
        "publishing_results",
      );
      expect(database.state.manifests).toHaveLength(0);
    } else {
      service.runUntilIdle();
      expect(service.status(receipt.runId)?.attempt.state).toBe("succeeded");
      expect(database.state.manifests).toHaveLength(1);
    }
  });

  it("deduplicates redelivered outbox events through the durable inbox", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const receipt = service.submit({
      idempotencyKey: "duplicate-event",
      spec: spec("succeeded"),
    });
    service.runUntilIdle();
    const counts = {
      allocations: database.state.allocations.size,
      dispatches: database.state.dispatches.size,
      executions: database.state.executions.size,
      manifests: database.state.manifests.size,
      mappings: database.state.mappings.size,
    };
    const messageId = `message:ready:${receipt.attemptId}:0`;

    service.redeliver(messageId);
    service.runUntilIdle();

    expect(
      database.state.inbox.get(`phase1-process-manager:${messageId}`),
    ).toEqual({
      completed: true,
      consumer: "phase1-process-manager",
      messageId,
    });
    expect({
      allocations: database.state.allocations.size,
      dispatches: database.state.dispatches.size,
      executions: database.state.executions.size,
      manifests: database.state.manifests.size,
      mappings: database.state.mappings.size,
    }).toEqual(counts);
  });

  it("cancels before dispatch, supersedes queued start, and deduplicates cancellation", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const accepted = service.submit({
      idempotencyKey: "cancel-before-dispatch",
      spec: spec("succeeded"),
    });

    const first = service.cancel(accepted.runId, "cancel-once");
    const duplicate = service.cancel(accepted.runId, "cancel-once");
    service.runUntilIdle();

    expect(duplicate).toEqual(first);
    expect(service.status(accepted.runId)?.attempt).toMatchObject({
      cancellationDesired: "requested",
      startAuthorization: "revoked",
      state: "canceled",
    });
    expect(database.state.dispatches).toHaveLength(0);
    expect(database.state.executions).toHaveLength(0);
    expect(database.state.manifests).toHaveLength(1);
    expect(service.operationStatus(first.operationId)?.kind).toBe("cancel");
    expect(service.step()).toBe(false);
    expect(service.cancel(accepted.runId, "cancel-once")).toEqual(first);
  });

  it.each([1, 2, 3, 4])(
    "converges cancellation race after process-manager boundary %i",
    (boundary) => {
      const database = createSyntheticDatabase(profile);
      let service = createPhase1SyntheticService(database);
      const accepted = service.submit({
        idempotencyKey: `cancel-race-${String(boundary)}`,
        spec: spec("succeeded"),
      });
      for (let index = 0; index < boundary; index += 1) service.step();
      const receipt = service.cancel(
        accepted.runId,
        `cancel-race-${String(boundary)}`,
      );

      service = createPhase1SyntheticService(database);
      service.runUntilIdle();

      expect(service.status(accepted.runId)?.attempt.state).toBe("canceled");
      expect(
        service.cancel(accepted.runId, `cancel-race-${String(boundary)}`),
      ).toEqual(receipt);
      expect(service.capacity()).toEqual({
        reservedCpuMillis: 0,
        reservedMemoryMiB: 0,
      });
      expect(database.state.releaseReceipts.size).toBeLessThanOrEqual(1);
      expect(database.state.manifests).toHaveLength(1);
      const dispatchId = service.status(accepted.runId)?.attempt.dispatchId;
      if (dispatchId !== undefined) {
        expect(service.dispatchObservation(dispatchId)).toBe("canceled");
      }
    },
  );

  it("converges after a service restart at every durable process-manager boundary", () => {
    const database = createSyntheticDatabase(profile);
    let service = createPhase1SyntheticService(database);
    const receipt = service.submit({
      idempotencyKey: "restart-everywhere",
      spec: spec("succeeded"),
    });
    const observedStates: string[] = [];

    for (let boundary = 0; boundary < 12; boundary += 1) {
      service = createPhase1SyntheticService(database);
      const changed = service.step();
      observedStates.push(
        service.status(receipt.runId)?.attempt.state ?? "missing",
      );
      if (!changed) break;
    }

    expect(observedStates).toEqual([
      "queued",
      "admitted",
      "dispatching",
      "running",
      "publishing_results",
      "publishing_results",
      "publishing_results",
      "publishing_results",
      "succeeded",
      "succeeded",
    ]);
    expect(database.state.executions).toHaveLength(1);
    expect(database.state.manifests).toHaveLength(1);
    expect(database.state.releaseReceipts).toHaveLength(1);
  });

  it("rolls back rejected attachment and durably continues reservation", () => {
    const database = createSyntheticDatabase(profile);
    let service = createPhase1SyntheticService(database);
    service.rejectNextAttachment();
    const receipt = service.submit({
      idempotencyKey: "attachment-rejection",
      spec: spec("succeeded"),
    });

    expect(service.step()).toBe(true);
    service = createPhase1SyntheticService(database);
    expect(service.step()).toBe(true);
    expect(service.status(receipt.runId)?.attempt).toMatchObject({
      attachmentRejections: 1,
      reservationRequestRevision: 1,
      state: "queued",
    });
    expect(database.state.rollbackReceipts.size).toBe(1);
    expect([...database.state.rollbackReceipts.values()][0]?.kind).toBe(
      "nonterminal_attachment_rollback",
    );

    service = createPhase1SyntheticService(database);
    service.runUntilIdle();
    expect(service.status(receipt.runId)?.attempt.state).toBe("succeeded");
    expect(database.state.allocations).toHaveLength(2);
    expect(database.state.releaseReceipts).toHaveLength(1);
    expect(service.capacity()).toEqual({
      reservedCpuMillis: 0,
      reservedMemoryMiB: 0,
    });
  });

  it.each(["before-commit", "after-commit"] as const)(
    "recovers attachment-rejection continuation after a %s crash",
    (boundary) => {
      const database = createSyntheticDatabase(profile);
      let service = createPhase1SyntheticService(database);
      service.rejectNextAttachment();
      const receipt = service.submit({
        idempotencyKey: `attachment-crash-${boundary}`,
        spec: spec("succeeded"),
      });
      service.step();
      service.failNextAttachmentRejectionAt(boundary);

      expect(() => service.step()).toThrow(
        `Synthetic crash ${boundary === "before-commit" ? "before" : "after"} attachment rejection commit`,
      );
      expect(service.status(receipt.runId)?.attempt).toMatchObject(
        boundary === "before-commit"
          ? { attachmentRejections: 0, reservationRequestRevision: 0 }
          : { attachmentRejections: 1, reservationRequestRevision: 1 },
      );
      expect(database.state.rollbackReceipts.size).toBe(
        boundary === "before-commit" ? 0 : 1,
      );

      service = createPhase1SyntheticService(database);
      service.runUntilIdle();
      expect(service.status(receipt.runId)?.attempt).toMatchObject({
        attachmentRejections: 1,
        reservationRequestRevision: 1,
        state: "succeeded",
      });
      expect(database.state.rollbackReceipts).toHaveLength(1);
      expect(database.state.releaseReceipts).toHaveLength(1);
    },
  );

  it("uses exactly seven owner participants and profile-specific atomic lock traces", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const receipt = service.submit({
      idempotencyKey: "participants",
      spec: spec("succeeded"),
    });
    service.runUntilIdle();

    expect(service.participantCount).toBe(7);
    expect(database.state.lockTrace).toContain(
      `${profile}:accept-workload-v1:${receipt.operationId}:begin:accept-workload-v1`,
    );
    if (profile === "sqlite") {
      expect(database.state.lockTrace).toContain(
        `sqlite:accept-workload-v1:${receipt.operationId}:beginImmediate`,
      );
    }
    expect(database.state.lockTrace).toContain(
      `${profile}:accept-workload-v1:${receipt.operationId}:commit`,
    );
    const expectedRanks = [10, 20, 30, 60, 110, 120, 130, 140, 150];
    for (const rank of expectedRanks) {
      expect(database.state.lockTrace).toContain(
        profile === "postgres"
          ? `postgres:accept-workload-v1:${receipt.operationId}:physicalLock:${String(rank)}:SELECT FOR UPDATE`
          : `sqlite:accept-workload-v1:${receipt.operationId}:rankedKeyLoad:${String(rank)}`,
      );
    }
    expect(database.state.schemaTables).toEqual(
      expect.arrayContaining([
        "workloads",
        "allocations",
        "dispatch_mappings",
        "result_manifests",
        "command_inbox",
        "transactional_outbox",
        "audit_ledger",
        "status_projection",
      ]),
    );
    expect(database.state.audit.map((record) => record.action)).toEqual([
      "workload.accepted",
      "attempt.succeeded",
    ]);
    expect(database.state.projections.get(receipt.runId)?.state).toBe(
      "succeeded",
    );
  });

  it("binds reconciliation progress to a current claim fence", () => {
    const database = createSyntheticDatabase(profile);
    let service = createPhase1SyntheticService(database);
    service.ownershipTransfer.begin(
      "reconcile-1",
      "test://phase1/walking-slice",
    );
    const expired = service.ownershipTransfer.claim(
      "reconcile-1",
      "worker-old",
      0,
      10,
      0,
    );

    service = createPhase1SyntheticService(database);
    const current = service.ownershipTransfer.claim(
      "reconcile-1",
      "worker-new",
      11,
      100,
      1,
    );

    expect(() => {
      service.ownershipTransfer.recordStep(
        "reconcile-1",
        "epoch-advanced",
        expired,
        11,
      );
    }).toThrow("Stale reconciliation claim");
    expect(() => {
      service.claimStore.release(expired);
    }).toThrow("Stale reconciliation claim");
    expect(
      service.ownershipTransfer.recordStep(
        "reconcile-1",
        "epoch-advanced",
        current,
        11,
      ).state,
    ).toBe("epoch_advanced");
    service.ownershipTransfer.acknowledge(
      "reconcile-1",
      "synthetic-authority",
      current,
      11,
    );
    expect(
      service.ownershipTransfer.complete("reconcile-1", current, 11).state,
    ).toBe("completed");
    expect(service.ownershipTransfer.discoverIncomplete()).toEqual([]);
  });

  it("serializes static reservations without overcommit", () => {
    const service = createPhase1SyntheticService(
      createSyntheticDatabase(profile),
    );
    const first = service.submit({
      idempotencyKey: "capacity-a",
      spec: spec("succeeded", [], 3000),
    });
    const second = service.submit({
      idempotencyKey: "capacity-b",
      spec: spec("succeeded", [], 3000),
    });

    service.reserve(first.runId);
    expect(() => service.reserve(second.runId)).toThrow(
      CapacityUnavailableError,
    );
    expect(service.capacity()).toEqual({
      reservedCpuMillis: 3000,
      reservedMemoryMiB: 256,
    });
  });

  it("enforces a closed revisioned dispatch gate at the final local boundary", () => {
    const database = createSyntheticDatabase(profile);
    const service = createPhase1SyntheticService(database);
    const accepted = service.submit({
      idempotencyKey: "close-dispatch-gate",
      spec: spec("succeeded"),
    });
    service.step();
    service.step();
    const status = service.status(accepted.runId);
    if (status === undefined) throw new Error("Workload status is missing");
    database.state.gateSet = closeOperationGates({
      authorizationGate: "dispatch",
      current: database.state.gateSet,
      expectedRevision: 1,
      gates: ["dispatch"],
      mutationFence: prepareSyntheticMutationFence({
        attempt: status.attempt,
        desiredEffect: "dispatch_submit",
        effectScopeKey: `dispatch:${status.attempt.attemptId}`,
        expectedDesiredVersion: 1,
        gateRevision: 1,
        namespaceId: database.state.gateSet.namespaceId,
        requiredGate: "dispatch",
        supersessionKey: `dispatch:${status.attempt.attemptId}`,
      }),
    });

    expect(() => service.step()).toThrow("Operation gate is closed: dispatch");
    expect(database.state.dispatches).toHaveLength(0);

    database.state.gateSet = openSyntheticTestGates(database.state.gateSet, 2);
    service.runUntilIdle();
    expect(service.status(accepted.runId)?.attempt.state).toBe("succeeded");
  });
});

describe("revisioned operation gates", () => {
  it("remain closed by default and cannot open outside a synthetic test namespace", () => {
    const closed = createClosedGateSet("production/default");
    expect(() => {
      assertGateOpen(closed, "start");
    }).toThrow(ClosedOperationGateError);
    expect(() => openSyntheticTestGates(closed, 0)).toThrow(
      "only open in the Phase 1 test namespace",
    );
  });
});

describe.each(profiles)("Phase 1 %s authenticated API", (profile) => {
  it("exposes submit, status, cancel, and operation status from transport identity", () => {
    const service = createPhase1SyntheticService(
      createSyntheticDatabase(profile),
    );
    const api = createSyntheticHttpApi(createWorkloadApi(service));

    expect(() =>
      api.submit("untrusted", {
        idempotencyKey: "api-denied",
        spec: spec("succeeded"),
      }),
    ).toThrow(AuthenticationError);
    const accepted = api.submit("phase1-synthetic-token", {
      idempotencyKey: "api-submit",
      spec: spec("succeeded"),
    });
    expect(accepted.status).toBe(202);
    expect(
      api.status("phase1-synthetic-token", accepted.body.runId).status,
    ).toBe(200);
    expect(
      api.operationStatus("phase1-synthetic-token", accepted.body.operationId),
    ).toMatchObject({ status: 200 });
    expect(
      api.cancel("phase1-synthetic-token", accepted.body.runId, "api-cancel"),
    ).toMatchObject({ status: 202 });
  });
});

describe("safe local filesystem artifact adapter", () => {
  it("writes only regular files under a disposable synthetic root", async () => {
    const root = await mkdtemp(join(tmpdir(), "workload-funnel-phase1-"));
    try {
      const writer = createLocalFilesystemArtifactWriter(root);
      const command = (
        attemptId: string,
        path: string,
        content: string,
        openGates: ReadonlySet<string> = new Set(["result_finalize"]),
      ) =>
        createSyntheticArtifactFinalizeCommand({
          attemptId,
          content,
          executionGeneration: "generation-1",
          gateRevision: 1,
          namespaceId: "test://phase1/walking-slice",
          openGates,
          path,
        });
      const path = await writer.write(
        command("attempt-1", "nested/result.txt", "synthetic\n"),
      );
      expect(await readFile(path, "utf8")).toBe("synthetic\n");
      await expect(
        writer.write(command("attempt-closed", "blocked.txt", "no", new Set())),
      ).rejects.toThrow("superseded_by_gate");
      await expect(
        writer.write(command("attempt-1", "../escape", "no")),
      ).rejects.toThrow(UnsafeArtifactPathError);

      await symlink("/tmp", join(root, "attempt-link"));
      await expect(
        writer.write(command("attempt-link", "escaped.txt", "no")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
