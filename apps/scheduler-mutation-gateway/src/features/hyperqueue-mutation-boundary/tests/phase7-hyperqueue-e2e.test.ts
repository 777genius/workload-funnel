import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintMutationFence } from "@workload-funnel/kernel";
import {
  CHECKED_HYPERQUEUE_PRODUCTION_GATE,
  discoverHyperQueueCapabilities,
  HYPERQUEUE_RESEARCH_BASELINE,
} from "@workload-funnel/scheduler-hyperqueue/capability-discovery";
import { createProvider as createCancellationProvider } from "@workload-funnel/scheduler-hyperqueue/dispatch-cancellation";
import {
  createProvider as createObservationProvider,
  FilesystemHyperQueueObservationOrder,
} from "@workload-funnel/scheduler-hyperqueue/dispatch-observation";
import { createProvider as createSubmissionProvider } from "@workload-funnel/scheduler-hyperqueue/dispatch-submission";
import { reconcileHyperQueueDispatch } from "@workload-funnel/scheduler-hyperqueue/hyperqueue-reconciliation";
import { createProvider as createWorkerInventoryProvider } from "@workload-funnel/scheduler-hyperqueue/worker-inventory";

import {
  createSyntheticGateway,
  createSyntheticGatewayEnvironment,
  executeSyntheticRead,
  installAndOpen,
  installAndKeepClosed,
  schedulerFence,
  scope,
  syntheticState,
  unusedShimInvocation,
  type SyntheticGatewayEnvironment,
} from "./gateway-test-fixture.js";

const environments: SyntheticGatewayEnvironment[] = [];

function observationOrder(
  environment: SyntheticGatewayEnvironment,
  name: string,
): FilesystemHyperQueueObservationOrder {
  return new FilesystemHyperQueueObservationOrder(
    `${environment.directory}/${name}.wal`,
  );
}

afterEach(() => {
  for (const environment of environments.splice(0))
    rmSync(environment.directory, { force: true, recursive: true });
});

describe(
  "Phase 7 isolated HyperQueue server/worker-style E2E",
  { timeout: 20_000 },
  () => {
    const readLimits = { maxOutputBytes: 128 * 1024, timeoutMs: 5_000 };

    it("keeps the research baseline explicit and production enablement closed", () => {
      expect(HYPERQUEUE_RESEARCH_BASELINE).toBe("0.26.2");
      const capabilities = discoverHyperQueueCapabilities();
      expect(capabilities.productionEnabled).toBe(false);
      expect(capabilities.available).not.toEqual(
        expect.arrayContaining([
          "hard_process_ownership",
          "lookup_by_operation_id",
          "never_restart",
          "process_tree_cancellation",
          "submit_idempotency",
          "tenant_isolation",
        ]),
      );
      expect(capabilities.refusalReasons).toEqual(
        expect.arrayContaining([
          "production_pin_unapproved",
          "ambiguous_submit_lookup_unsupported",
        ]),
      );
      expect(capabilities.limitations).toEqual(
        expect.arrayContaining([
          "no_scheduler_tenant_fairness",
          "logical_resources_not_hard_isolation",
          "submit_outcome_not_idempotent",
          "worker_loss_restart_policy_unproven",
          "transport_security_unproven",
          "upstream_recovery_risk_unresolved",
        ]),
      );
      expect(CHECKED_HYPERQUEUE_PRODUCTION_GATE).toMatchObject({
        approvedProductionChecksum: null,
        approvedProductionVersion: null,
        ambiguousSubmitLookupProven: false,
        cancellationProcessTreeProven: false,
        durableObservationSequenceProven: true,
        neverRestartProven: false,
        productionPolicyProfileApproved: false,
        securityReviewApproved: false,
        upstreamRiskDecisionApproved: false,
      });
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      expect(() =>
        createSyntheticGateway(environment, { mode: "production" }),
      ).toThrow("hyperqueue_production_pin_unapproved");
    });

    it("submits, observes a synthetic worker, preserves worker-loss ambiguity, and cancels", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await expect(gateway.recovery.recover()).resolves.toMatchObject({
        mutationReady: true,
        observationReady: true,
      });

      const submitScope = scope("dispatch_submit");
      const submitFence = schedulerFence("dispatch_submit");
      const submitAck = await installAndOpen(gateway, submitScope, submitFence);
      const submission = createSubmissionProvider(gateway);
      const submitted = await submission.submitAfterInstall({
        acknowledgedInstall: submitAck,
        dispatchId: "dispatch-1",
        jobName: "wf-dispatch-1",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: submitFence,
        operationId: "submit-operation-1",
        requestedCpuCount: 1,
        requiredCustomResources: { gpu: 1 },
        scope: submitScope,
        shimInvocation: unusedShimInvocation(),
      });
      expect(submitted.disposition).toBe("accepted");
      expect(syntheticState(environment).mutationCalls).toBe(1);
      expect(syntheticState(environment).submissions["1"]).toEqual({
        requestedCpuCount: 1,
        requiredCustomResources: { gpu: 1 },
        restartPolicy: "never",
      });

      const readExecutor = {
        executeRead: (args: readonly string[]) =>
          executeSyntheticRead(environment, args),
        async verifyExactVersion(expected: string) {
          const output = await executeSyntheticRead(environment, ["--version"]);
          if (output.trim() !== expected) throw new Error("version mismatch");
        },
      };
      const observer = createObservationProvider(
        readExecutor,
        "0.26.2",
        readLimits,
        observationOrder(environment, "dispatch-order"),
      );
      await observer.initialize();
      const mapping = {
        jobId: "1",
        mappingFingerprint: "mapping-fingerprint-1",
        taskId: "0",
      };
      await expect(observer.observe(mapping)).resolves.toMatchObject({
        dispatchEvidence: { observed: "accepted" },
        schedulerState: "waiting",
      });

      await executeSyntheticRead(environment, [
        "fixture-worker",
        "1",
        "running",
      ]);
      await expect(observer.observe(mapping)).resolves.toMatchObject({
        dispatchEvidence: { observed: "running" },
        schedulerState: "running",
      });

      await executeSyntheticRead(environment, ["fixture-worker", "1", "lost"]);
      const lost = await observer.observe(mapping);
      expect(lost.dispatchEvidence.complete).toBe(false);
      expect(
        reconcileHyperQueueDispatch({
          mappingPresent: true,
          observations: [lost.dispatchEvidence],
          shimProtocol: "phase7.scheduler-shim.v1",
          submitReceipt: submitted.evidence,
        }),
      ).toEqual({
        disposition: "reconciliation_required",
        reason: "worker_loss_or_observation_ambiguous",
        resubmit: false,
      });

      const cancelScope = scope("dispatch_cancel");
      const cancelFence = schedulerFence("dispatch_cancel", 1);
      const revokedSubmitFence = schedulerFence("dispatch_submit", 2, {
        issuedStartRevocationRevision: 1,
      });
      const submitRevocationAcknowledgement = await installAndKeepClosed(
        gateway,
        submitScope,
        revokedSubmitFence,
        fingerprintMutationFence(submitFence),
        "cancel-submit-revocation",
      );
      const cancelAck = await installAndOpen(
        gateway,
        cancelScope,
        cancelFence,
        null,
        "cancel-1",
      );
      const cancellation = createCancellationProvider(gateway, observer);
      const canceled = await cancellation.cancelAfterInstall({
        acknowledgedInstall: cancelAck,
        dispatchId: "dispatch-1",
        jobId: "1",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: cancelFence,
        operationId: "cancel-operation-1",
        scope: cancelScope,
        submitRevocationAcknowledgement,
        taskId: "0",
      });
      expect(canceled.disposition).toBe("accepted");
      await expect(observer.observe(mapping)).resolves.toMatchObject({
        dispatchEvidence: { observed: "terminal" },
        schedulerState: "canceled",
      });
      expect(syntheticState(environment).mutationCalls).toBe(2);

      const inventory = createWorkerInventoryProvider(
        {
          executeRead: (args) => executeSyntheticRead(environment, args),
        },
        readLimits,
        observationOrder(environment, "worker-order"),
      );
      await expect(inventory.inventory()).resolves.toMatchObject({
        workers: [{ customResources: { gpu: 1 }, workerId: "worker-1" }],
      });
    });

    it("preserves journal-flushed work and makes pre-flush server restart ambiguity explicit", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const submitScope = scope("dispatch_submit", "dispatch-restart");
      const submitFence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-restart",
        supersessionKey: "dispatch:dispatch-restart",
      });
      const acknowledgement = await installAndOpen(
        gateway,
        submitScope,
        submitFence,
        null,
        "server-restart",
      );
      const submitted = await createSubmissionProvider(
        gateway,
      ).submitAfterInstall({
        acknowledgedInstall: acknowledgement,
        dispatchId: "dispatch-restart",
        jobName: "wf-dispatch-restart",
        mappingFingerprint: "mapping-fingerprint-restart",
        mutationFence: submitFence,
        operationId: "submit-server-restart",
        requestedCpuCount: 1,
        requiredCustomResources: {},
        scope: submitScope,
        shimInvocation: {
          ...unusedShimInvocation(),
          dispatchId: "dispatch-restart",
          mappingFingerprint: "mapping-fingerprint-restart",
        },
      });
      const observer = createObservationProvider(
        {
          executeRead: (args) => executeSyntheticRead(environment, args),
          async verifyExactVersion(expected) {
            const output = await executeSyntheticRead(environment, [
              "--version",
            ]);
            if (output.trim() !== expected) throw new Error("version mismatch");
          },
        },
        "0.26.2",
        readLimits,
        observationOrder(environment, "restart-dispatch-order"),
      );
      await observer.initialize();
      const mapping = {
        jobId: "1",
        mappingFingerprint: "mapping-fingerprint-restart",
        taskId: "0",
      };
      await executeSyntheticRead(environment, [
        "fixture-server-restart",
        "after_flush",
      ]);
      await expect(observer.observe(mapping)).resolves.toMatchObject({
        dispatchEvidence: { complete: true, observed: "accepted" },
        schedulerState: "waiting",
      });
      await executeSyntheticRead(environment, [
        "fixture-server-restart",
        "before_flush",
      ]);
      const ambiguous = await observer.observe(mapping);
      expect(ambiguous).toMatchObject({
        dispatchEvidence: {
          complete: false,
          observed: "reconciliation_required",
        },
        schedulerState: "unknown",
      });
      expect(
        reconcileHyperQueueDispatch({
          mappingPresent: true,
          observations: [ambiguous.dispatchEvidence],
          shimProtocol: "phase7.scheduler-shim.v1",
          submitReceipt: submitted.evidence,
        }),
      ).toEqual({
        disposition: "reconciliation_required",
        reason: "worker_loss_or_observation_ambiguous",
        resubmit: false,
      });
    });

    it("never resubmits an unknown submit without an immutable mapping", () => {
      const submitFence = schedulerFence("dispatch_submit");
      const decision = reconcileHyperQueueDispatch({
        mappingPresent: false,
        observations: [],
        shimProtocol: "phase7.scheduler-shim.v1",
        submitReceipt: {
          authorityId: "gateway-1",
          authorityRegistrySequence: 1,
          comparisonFields: {},
          comparisonResult: "lost_response",
          effectKind: "dispatch_submit",
          effectScopeKey: submitFence.effectScopeKey,
          mutationFence: submitFence,
          mutationFenceFingerprint: "fence-unknown",
          operationId: "submit-unknown",
          outcome: "unknown",
          reason: "lost_response",
        },
      });
      expect(decision).toEqual({
        disposition: "reconciliation_required",
        reason: "ambiguous_submit_lookup_by_operation_unsupported",
        resubmit: false,
      });
    });

    it("rejects oversized read-only CLI output before schema decoding", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const oversized = "x".repeat(1_025);
      const limits = { maxOutputBytes: 1_024, timeoutMs: 5_000 };
      const observer = createObservationProvider(
        {
          executeRead: () => Promise.resolve(oversized),
          verifyExactVersion: () => Promise.resolve(),
        },
        "0.26.2",
        limits,
        observationOrder(environment, "oversized-dispatch-order"),
      );
      await expect(
        observer.observe({
          jobId: "1",
          mappingFingerprint: "mapping-fingerprint-1",
          taskId: "0",
        }),
      ).rejects.toThrow("hyperqueue_observation_output_limit_exceeded");
      const inventory = createWorkerInventoryProvider(
        { executeRead: () => Promise.resolve(oversized) },
        limits,
        observationOrder(environment, "oversized-worker-order"),
      );
      await expect(inventory.inventory()).rejects.toThrow(
        "hyperqueue_worker_inventory_output_limit_exceeded",
      );
    });

    it("orders recovered scheduler evidence by epoch and quarantines conflicts", () => {
      const submitFence = schedulerFence("dispatch_submit");
      const submitReceipt = {
        authorityId: "gateway-1",
        authorityRegistrySequence: 1,
        comparisonFields: {},
        comparisonResult: "applied",
        effectKind: "dispatch_submit" as const,
        effectScopeKey: submitFence.effectScopeKey,
        mutationFence: submitFence,
        mutationFenceFingerprint: "fence-applied",
        operationId: "submit-applied",
        outcome: "applied" as const,
        reason: "applied",
      };
      const base = {
        complete: true,
        kind: "adapter_lookup" as const,
        source: "scheduler-hyperqueue",
      };
      expect(
        reconcileHyperQueueDispatch({
          mappingPresent: true,
          observations: [
            {
              ...base,
              digest: "old-terminal",
              observed: "terminal",
              sourceEpoch: 1,
              sourceSequence: 99,
            },
            {
              ...base,
              digest: "new-running",
              observed: "running",
              sourceEpoch: 2,
              sourceSequence: 1,
            },
          ],
          shimProtocol: "phase7.scheduler-shim.v1",
          submitReceipt,
        }),
      ).toMatchObject({ disposition: "running", resubmit: false });
      expect(
        reconcileHyperQueueDispatch({
          mappingPresent: true,
          observations: [
            {
              ...base,
              digest: "first",
              observed: "running",
              sourceEpoch: 2,
              sourceSequence: 2,
            },
            {
              ...base,
              digest: "conflict",
              observed: "terminal",
              sourceEpoch: 2,
              sourceSequence: 2,
            },
          ],
          shimProtocol: "phase7.scheduler-shim.v1",
          submitReceipt,
        }),
      ).toEqual({
        disposition: "reconciliation_required",
        reason: "conflicting_scheduler_evidence",
        resubmit: false,
      });
    });
  },
);
