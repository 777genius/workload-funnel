import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintMutationFence } from "@workload-funnel/kernel";
import { createHyperQueueCancelMutation } from "@workload-funnel/scheduler-hyperqueue/dispatch-cancellation";

import {
  createSyntheticGateway,
  createSyntheticGatewayEnvironment,
  installAndKeepClosed,
  installAndOpen,
  schedulerFence,
  scope,
  syntheticState,
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
        jobId: "job-1",
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
  },
);
