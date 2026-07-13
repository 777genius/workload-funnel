import { readFileSync, rmSync, writeFileSync } from "node:fs";

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
  submitRequest,
  syntheticState,
  type SyntheticGatewayEnvironment,
} from "./gateway-test-fixture.js";

const environments: SyntheticGatewayEnvironment[] = [];

afterEach(() => {
  for (const environment of environments.splice(0))
    rmSync(environment.directory, { force: true, recursive: true });
});

function newerScopeBFence(dispatchId: string) {
  return schedulerFence("dispatch_submit", 1, {
    clusterIncarnation: "cluster-2",
    clusterIncarnationVersion: 2,
    effectScopeKey: `scheduler-dispatch:${dispatchId}`,
    issuedStartRevocationRevision: 2,
    namespaceWriterEpoch: 2,
    operationGateRevision: 2,
    ownerFence: 2,
    supersessionKey: `dispatch:${dispatchId}`,
  });
}

describe(
  "Phase 7 scheduler gateway durable cross-scope high-watermarks",
  { timeout: 20_000 },
  () => {
    it("rejects an old scope A tuple and acknowledgement after scope B advances shared authority", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();

      const scopeA = scope("dispatch_submit", "dispatch-scope-a");
      const fenceA = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-scope-a",
        supersessionKey: "dispatch:dispatch-scope-a",
      });
      const acknowledgementA = await installAndOpen(
        gateway,
        scopeA,
        fenceA,
        null,
        "scope-a",
      );
      const scopeB = scope("dispatch_submit", "dispatch-scope-b");
      const fenceB = newerScopeBFence("dispatch-scope-b");
      await installAndOpen(gateway, scopeB, fenceB, null, "scope-b-newer");

      const rejectedInstall = await installAndKeepClosed(
        gateway,
        scopeA,
        fenceA,
        fingerprintMutationFence(fenceA),
        "scope-a-stale-reinstall",
      );
      expect(rejectedInstall.claims).toMatchObject({
        comparisonResult: "lower",
        result: "rejected",
      });
      await expect(
        gateway.reopen({
          acknowledgement: acknowledgementA,
          reopenOperationId: "scope-a-stale-reopen",
        }),
      ).rejects.toThrow("invalid_gateway_request:reopen_ack");
      await expect(
        gateway.mutate(
          submitRequest(
            scopeA,
            fenceA,
            acknowledgementA,
            "scope-a-stale-submit",
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("recovers B maxima from the fsynced WAL and does not require stale A revalidation", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const scopeA = scope("dispatch_submit", "dispatch-restart-a");
      const fenceA = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-restart-a",
        supersessionKey: "dispatch:dispatch-restart-a",
      });
      const acknowledgementA = await installAndOpen(
        gateway,
        scopeA,
        fenceA,
        null,
        "restart-a",
      );
      const scopeB = scope("dispatch_submit", "dispatch-restart-b");
      const fenceB = newerScopeBFence("dispatch-restart-b");
      await installAndOpen(gateway, scopeB, fenceB, null, "restart-b");

      const restarted = createSyntheticGateway(environment);
      await expect(restarted.recovery.recover()).resolves.toMatchObject({
        mutationReady: false,
        reason: "authority_revalidation_required",
      });
      await installAndOpen(
        restarted,
        scopeB,
        fenceB,
        fingerprintMutationFence(fenceB),
        "restart-b-revalidated",
      );
      await expect(restarted.recovery.recover()).resolves.toMatchObject({
        mutationReady: true,
      });
      await expect(
        restarted.mutate(
          submitRequest(
            scopeA,
            fenceA,
            acknowledgementA,
            "restart-a-stale-submit",
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("rechecks scope A after an asynchronous wait loses to scope B takeover", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      let releaseWait: (() => void) | undefined;
      let waitEntered: (() => void) | undefined;
      const entered = new Promise<void>((resolve) => {
        waitEntered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        releaseWait = resolve;
      });
      const gateway = createSyntheticGateway(environment, {
        faults: {
          async beforeFinalValidationWait(request) {
            if (request.operationId !== "waiting-scope-a-submit") return;
            waitEntered?.();
            await wait;
          },
        },
      });
      await gateway.recovery.recover();
      const scopeA = scope("dispatch_submit", "dispatch-wait-a");
      const fenceA = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-wait-a",
        supersessionKey: "dispatch:dispatch-wait-a",
      });
      const acknowledgementA = await installAndOpen(
        gateway,
        scopeA,
        fenceA,
        null,
        "wait-a",
      );
      const waitingMutation = gateway.mutate(
        submitRequest(
          scopeA,
          fenceA,
          acknowledgementA,
          "waiting-scope-a-submit",
        ),
      );
      await entered;
      const scopeB = scope("dispatch_submit", "dispatch-wait-b");
      await installAndOpen(
        gateway,
        scopeB,
        newerScopeBFence("dispatch-wait-b"),
        null,
        "wait-b-takeover",
      );
      releaseWait?.();

      await expect(waitingMutation).resolves.toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("rejects cancellation when B invalidates both old cancel and submit-revocation acknowledgements", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const submitScopeA = scope("dispatch_submit", "dispatch-cancel-a");
      const initialSubmitFenceA = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-cancel-a",
        supersessionKey: "dispatch:dispatch-cancel-a",
      });
      await installAndOpen(
        gateway,
        submitScopeA,
        initialSubmitFenceA,
        null,
        "cancel-a-submit",
      );
      const revokedSubmitFenceA = Object.freeze({
        ...initialSubmitFenceA,
        expectedDesiredVersion: 2,
        issuedStartRevocationRevision: 1,
      });
      const revocationAcknowledgementA = await installAndKeepClosed(
        gateway,
        submitScopeA,
        revokedSubmitFenceA,
        fingerprintMutationFence(initialSubmitFenceA),
        "cancel-a-revocation",
      );
      const cancelScopeA = scope("dispatch_cancel", "dispatch-cancel-a");
      const cancelFenceA = schedulerFence("dispatch_cancel", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-cancel-a",
        supersessionKey: "dispatch:dispatch-cancel-a",
      });
      const cancelAcknowledgementA = await installAndOpen(
        gateway,
        cancelScopeA,
        cancelFenceA,
        null,
        "cancel-a-effect",
      );

      const submitScopeB = scope("dispatch_submit", "dispatch-cancel-b");
      await installAndKeepClosed(
        gateway,
        submitScopeB,
        newerScopeBFence("dispatch-cancel-b"),
        null,
        "cancel-b-newer",
      );
      const staleCancellation = createHyperQueueCancelMutation({
        acknowledgedInstall: cancelAcknowledgementA,
        dispatchId: "dispatch-cancel-a",
        jobId: "job-1",
        mappingFingerprint: "mapping-fingerprint-1",
        mutationFence: cancelFenceA,
        operationId: "cancel-a-after-b",
        scope: cancelScopeA,
        submitRevocationAcknowledgement: revocationAcknowledgementA,
        taskId: "0",
      });
      await expect(gateway.mutate(staleCancellation)).resolves.toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("cordons mutation when durable cross-scope authority is missing or corrupt", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const targetScope = scope("dispatch_submit", "dispatch-corrupt-maxima");
      const fence = newerScopeBFence("dispatch-corrupt-maxima");
      await installAndOpen(gateway, targetScope, fence, null, "corrupt-maxima");
      const wal = readFileSync(environment.walPath, "utf8");
      expect(wal).toContain('"authorityHighWatermarks"');
      writeFileSync(
        environment.walPath,
        wal.replace(
          '"authorityHighWatermarks"',
          '"missingAuthorityHighWatermarks"',
        ),
        "utf8",
      );

      const restarted = createSyntheticGateway(environment);
      await expect(restarted.recovery.recover()).resolves.toEqual({
        mutationReady: false,
        observationReady: true,
        reason: "gateway_registry_unprovable",
        recoveredUnknownOperations: [],
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });
  },
);
