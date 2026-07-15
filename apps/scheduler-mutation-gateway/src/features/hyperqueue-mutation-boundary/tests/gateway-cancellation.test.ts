import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintMutationFence } from "@workload-funnel/kernel";
import {
  createHyperQueueCancelMutation,
  createProvider as createCancellationProvider,
} from "@workload-funnel/scheduler-hyperqueue/dispatch-cancellation";
import { createProvider as createSubmissionProvider } from "@workload-funnel/scheduler-hyperqueue/dispatch-submission";

import {
  createSyntheticGateway,
  createSyntheticGatewayEnvironment,
  installAndKeepClosed,
  installAndOpen,
  schedulerFence,
  scope,
  syntheticState,
  unusedShimInvocation,
  type SyntheticGatewayEnvironment,
} from "./gateway-test-fixture.js";

const environments: SyntheticGatewayEnvironment[] = [];

afterEach(() => {
  for (const environment of environments.splice(0))
    rmSync(environment.directory, { force: true, recursive: true });
});

describe(
  "Phase 7 cancellation start-revocation barrier",
  { timeout: 20_000 },
  () => {
    it("requires a drained, current, and still-closed submit revocation before final cancel CLI", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();

      const submitScope = scope("dispatch_submit", "dispatch-cancel-barrier");
      const initialSubmitFence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-cancel-barrier",
        supersessionKey: "dispatch:dispatch-cancel-barrier",
      });
      await installAndOpen(
        gateway,
        submitScope,
        initialSubmitFence,
        null,
        "cancel-barrier-initial-submit",
      );
      const revokedSubmitFence = Object.freeze({
        ...initialSubmitFence,
        expectedDesiredVersion: 2,
        issuedStartRevocationRevision: 1,
      });
      const revocationAcknowledgement = await installAndKeepClosed(
        gateway,
        submitScope,
        revokedSubmitFence,
        fingerprintMutationFence(initialSubmitFence),
        "cancel-barrier-revocation",
      );

      const cancelScope = scope("dispatch_cancel", "dispatch-cancel-barrier");
      const cancelFence = schedulerFence("dispatch_cancel", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-cancel-barrier",
        supersessionKey: "dispatch:dispatch-cancel-barrier",
      });
      const cancelAcknowledgement = await installAndOpen(
        gateway,
        cancelScope,
        cancelFence,
        null,
        "cancel-barrier-cancel",
      );
      const request = createHyperQueueCancelMutation({
        acknowledgedInstall: cancelAcknowledgement,
        dispatchId: "dispatch-cancel-barrier",
        jobId: "1",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: cancelFence,
        operationId: "cancel-with-open-submit-revocation",
        scope: cancelScope,
        submitRevocationAcknowledgement: revocationAcknowledgement,
        taskId: "0",
      });

      await gateway.reopen({
        acknowledgement: revocationAcknowledgement,
        reopenOperationId: "unsafe-submit-reopen",
      });
      await expect(gateway.mutate(request)).resolves.toMatchObject({
        outcome: "rejected",
        reason: "submit_revocation_barrier_mismatch",
      });
      const missing = {
        ...request,
        operationId: "cancel-without-submit-revocation",
        submitRevocationAcknowledgement: undefined,
      };
      await expect(gateway.mutate(missing as never)).rejects.toThrow(
        "invalid_gateway_request",
      );
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("treats an empty cancel ACK as unknown until exact terminal re-observation", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const dispatchId = "dispatch-cancel-observation";
      const submitScope = scope("dispatch_submit", dispatchId);
      const submitFence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: `scheduler-dispatch:${dispatchId}`,
        supersessionKey: `dispatch:${dispatchId}`,
      });
      const submitAcknowledgement = await installAndOpen(
        gateway,
        submitScope,
        submitFence,
      );
      await createSubmissionProvider(gateway).submitAfterInstall({
        acknowledgedInstall: submitAcknowledgement,
        dispatchId,
        jobName: "wf-dispatch-cancel-observation",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: submitFence,
        operationId: "cancel-observation-submit",
        requestedCpuCount: 1,
        requiredCustomResources: {},
        scope: submitScope,
        shimInvocation: {
          ...unusedShimInvocation(),
          dispatchId,
          mappingFingerprint: "mapping-fingerprint-1",
        },
      });
      const revokedSubmitFence = Object.freeze({
        ...submitFence,
        expectedDesiredVersion: 2,
        issuedStartRevocationRevision: 1,
      });
      const submitRevocationAcknowledgement = await installAndKeepClosed(
        gateway,
        submitScope,
        revokedSubmitFence,
        fingerprintMutationFence(submitFence),
        "cancel-observation-submit-revocation",
      );
      const cancelScope = scope("dispatch_cancel", dispatchId);
      const cancelFence = schedulerFence("dispatch_cancel", 1, {
        effectScopeKey: `scheduler-dispatch:${dispatchId}`,
        supersessionKey: `dispatch:${dispatchId}`,
      });
      const acknowledgedInstall = await installAndOpen(
        gateway,
        cancelScope,
        cancelFence,
        null,
        "cancel-observation-install",
      );
      const input = {
        acknowledgedInstall,
        dispatchId,
        jobId: "1",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: cancelFence,
        operationId: "cancel-observation-operation",
        scope: cancelScope,
        submitRevocationAcknowledgement,
        taskId: "0",
      };
      expect(() =>
        createCancellationProvider(gateway, {
          observationOrderDurability: "volatile",
          observe: () =>
            Promise.resolve({ schedulerState: "canceled" as const }),
        }),
      ).toThrow("hyperqueue_cancel_observation_order_not_durable");
      const ambiguous = createCancellationProvider(gateway, {
        observationOrderDurability: "restart_durable",
        observe: () => Promise.resolve({ schedulerState: "running" as const }),
      });
      await expect(ambiguous.cancelAfterInstall(input)).resolves.toMatchObject({
        disposition: "unknown",
        evidence: {
          outcome: "unknown",
          reason: "hyperqueue_cancel_terminal_observation_required",
        },
      });
      expect(syntheticState(environment).mutationCalls).toBe(2);

      const exact = createCancellationProvider(gateway, {
        observationOrderDurability: "restart_durable",
        observe: () => Promise.resolve({ schedulerState: "canceled" as const }),
      });
      await expect(exact.cancelAfterInstall(input)).resolves.toMatchObject({
        disposition: "accepted",
      });
      expect(syntheticState(environment).mutationCalls).toBe(2);
    });
  },
);
