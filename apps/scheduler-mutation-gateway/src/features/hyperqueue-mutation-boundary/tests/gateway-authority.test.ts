import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  SCHEDULER_GATEWAY_PROTOCOL,
  signSchedulerFenceInstall,
} from "@workload-funnel/scheduler-hyperqueue/mutation-gateway-authority";
import {
  fingerprintMutationFence,
  type MutationFence,
} from "@workload-funnel/kernel";

import {
  createSyntheticGateway,
  createSyntheticGatewayEnvironment,
  installAndOpen,
  issuerKey,
  nowMs,
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

describe(
  "Phase 7 scheduler gateway final mutation authority",
  { timeout: 20_000 },
  () => {
    it("requires close, signed complete install acknowledgement, and reopen before issue", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const targetScope = scope("dispatch_submit");
      const fence = schedulerFence("dispatch_submit");
      const closeRequest = {
        authorityId: "gateway-1",
        closeOperationId: "close-install-order",
        scope: targetScope,
      } as const;
      const closed = await gateway.closeAndDrain(closeRequest);
      await expect(gateway.closeAndDrain(closeRequest)).resolves.toEqual(
        closed,
      );
      const installClaims = {
        authorityId: "gateway-1",
        expectedPriorFingerprint: null,
        installOperationId: "install-order",
        issuedAtMs: nowMs - 1,
        issuerKeyId: "issuer-1",
        mutationFence: fence,
        mutationFenceFingerprint: fingerprintMutationFence(fence),
        notAfterMs: nowMs + 60_000,
        protocolVersion: SCHEDULER_GATEWAY_PROTOCOL,
        reason: "desired_effect_supersession",
        scope: targetScope,
      } as const;
      const installRequest = signSchedulerFenceInstall(
        installClaims,
        issuerKey,
      );
      await expect(
        gateway.install({
          ...installRequest,
          signatureBase64Url: "A".repeat(43),
        }),
      ).rejects.toThrow("install_signature_invalid");
      const acknowledgement = await gateway.install(installRequest);
      await expect(gateway.install(installRequest)).resolves.toEqual(
        acknowledgement,
      );
      const collision = signSchedulerFenceInstall(
        { ...installClaims, issuedAtMs: nowMs - 2 },
        issuerKey,
      );
      await expect(gateway.install(collision)).rejects.toThrow(
        "operation_conflict:install",
      );
      const beforeReopen = await gateway.mutate(
        submitRequest(
          targetScope,
          fence,
          acknowledgement,
          "submit-before-reopen",
        ),
      );
      expect(beforeReopen).toMatchObject({
        outcome: "superseded",
        reason: "gateway_scope_closed",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
      await gateway.reopen({
        acknowledgement,
        reopenOperationId: "reopen-order",
      });
      const applied = await gateway.mutate(
        submitRequest(targetScope, fence, acknowledgement),
      );
      expect(applied).toMatchObject({
        comparisonFields: {
          expectedDesiredVersion: 1,
          issuedStartRevocationRevision: 0,
          supersessionKey: "dispatch:dispatch-1",
        },
        mutationFence: fence,
        mutationFenceFingerprint: fingerprintMutationFence(fence),
        outcome: "applied",
      });
      const replayed = await gateway.mutate(
        submitRequest(targetScope, fence, acknowledgement),
      );
      expect(replayed).toEqual(applied);
      expect(syntheticState(environment).mutationCalls).toBe(1);
    });

    it("rejects lower, missing, and equal-version mismatched tuples with zero CLI calls across takeover and restart", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const targetScope = scope("dispatch_submit");
      const firstFence = schedulerFence("dispatch_submit");
      const firstAck = await installAndOpen(gateway, targetScope, firstFence);
      const secondFence = schedulerFence("dispatch_submit", 2);
      const secondAck = await installAndOpen(
        gateway,
        targetScope,
        secondFence,
        fingerprintMutationFence(firstFence),
        "takeover",
      );
      const otherScope = scope("dispatch_submit", "dispatch-other-restart");
      const otherFence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-other-restart",
        supersessionKey: "dispatch:dispatch-other-restart",
      });
      await installAndOpen(
        gateway,
        otherScope,
        otherFence,
        null,
        "other-restart-scope",
      );

      const lower = await gateway.mutate(
        submitRequest(
          targetScope,
          firstFence,
          firstAck,
          "lower-after-takeover",
        ),
      );
      expect(lower).toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      const mismatchFence = schedulerFence("dispatch_submit", 2, {
        supersessionKey: "dispatch:another-command",
      });
      const mismatch = await gateway.mutate(
        submitRequest(
          targetScope,
          mismatchFence,
          secondAck,
          "equal-version-mismatch",
        ),
      );
      expect(mismatch).toMatchObject({
        outcome: "rejected",
        reason: "equal_version_mismatch",
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);

      const restarted = createSyntheticGateway(environment);
      await expect(restarted.recovery.recover()).resolves.toMatchObject({
        mutationReady: false,
        observationReady: true,
        reason: "authority_revalidation_required",
      });
      await expect(
        restarted.reopen({
          acknowledgement: secondAck,
          reopenOperationId: "stale-reopen-after-restart",
        }),
      ).rejects.toThrow("invalid_gateway_request:reopen_ack");
      await expect(
        restarted.mutate(
          submitRequest(
            targetScope,
            secondFence,
            secondAck,
            "current-before-revalidation",
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "superseded",
        reason: "gateway_scope_closed",
      });
      const revalidatedAck = await installAndOpen(
        restarted,
        targetScope,
        secondFence,
        fingerprintMutationFence(secondFence),
        "restart-revalidation",
      );
      await expect(restarted.recovery.recover()).resolves.toMatchObject({
        mutationReady: false,
        reason: "authority_revalidation_required",
      });
      await expect(
        restarted.mutate(
          submitRequest(
            targetScope,
            secondFence,
            revalidatedAck,
            "current-while-other-scope-unvalidated",
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "superseded",
        reason: "gateway_startup_revalidation_required",
      });
      await installAndOpen(
        restarted,
        otherScope,
        otherFence,
        fingerprintMutationFence(otherFence),
        "other-restart-revalidation",
      );
      await expect(restarted.recovery.recover()).resolves.toMatchObject({
        mutationReady: true,
      });
      const staleAfterRestart = await restarted.mutate(
        submitRequest(targetScope, firstFence, firstAck, "lower-after-restart"),
      );
      expect(staleAfterRestart).toMatchObject({
        outcome: "rejected",
        reason: "lower_authority",
      });
      const missing = {
        ...submitRequest(
          targetScope,
          secondFence,
          revalidatedAck,
          "missing-fence-after-restart",
        ),
        mutationFence: undefined,
      };
      await expect(restarted.mutate(missing as never)).rejects.toThrow();
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("rejects every lower revision and immutable tuple mismatch at the final boundary", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const targetScope = scope("dispatch_submit", "dispatch-components");
      const installed = schedulerFence("dispatch_submit", 2, {
        clusterIncarnationVersion: 2,
        effectScopeKey: "scheduler-dispatch:dispatch-components",
        issuedStartRevocationRevision: 2,
        namespaceWriterEpoch: 2,
        operationGateRevision: 2,
        ownerFence: 2,
        supersessionKey: "dispatch:dispatch-components",
      });
      const acknowledgement = await installAndOpen(
        gateway,
        targetScope,
        installed,
        null,
        "components",
      );
      const lowerFields: readonly (keyof MutationFence)[] = [
        "clusterIncarnationVersion",
        "namespaceWriterEpoch",
        "operationGateRevision",
        "ownerFence",
        "issuedStartRevocationRevision",
        "expectedDesiredVersion",
      ];
      for (const field of lowerFields) {
        const candidate = Object.freeze({ ...installed, [field]: 1 });
        await expect(
          gateway.mutate(
            submitRequest(
              targetScope,
              candidate,
              acknowledgement,
              `lower-${field}`,
            ),
          ),
        ).resolves.toMatchObject({
          outcome: "rejected",
          reason: "lower_authority",
        });
      }
      for (const [suffix, candidate] of [
        ["cluster-id", { ...installed, clusterIncarnation: "cluster-other" }],
        ["start-fence", { ...installed, startFence: "start-fence-other" }],
        ["supersession", { ...installed, supersessionKey: "dispatch:other" }],
        [
          "greater-supersession",
          {
            ...installed,
            clusterIncarnationVersion: 3,
            expectedDesiredVersion: 3,
            issuedStartRevocationRevision: 3,
            namespaceWriterEpoch: 3,
            operationGateRevision: 3,
            ownerFence: 3,
            supersessionKey: "dispatch:other",
          },
        ],
      ] as const) {
        await expect(
          gateway.mutate(
            submitRequest(
              targetScope,
              Object.freeze(candidate),
              acknowledgement,
              `mismatch-${suffix}`,
            ),
          ),
        ).resolves.toMatchObject({
          outcome: "rejected",
          reason: "equal_version_mismatch",
        });
      }
      const extraField = {
        ...submitRequest(
          targetScope,
          installed,
          acknowledgement,
          "extra-request-field",
        ),
        untrusted: true,
      };
      await expect(gateway.mutate(extraField as never)).rejects.toThrow(
        "invalid_gateway_request:mutation_request",
      );
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });

    it("revalidates a queued request after close wins and performs zero CLI calls", async () => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment);
      await gateway.recovery.recover();
      const targetScope = scope("dispatch_submit", "dispatch-waiting");
      const fence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: "scheduler-dispatch:dispatch-waiting",
        supersessionKey: "dispatch:dispatch-waiting",
      });
      const acknowledgement = await installAndOpen(
        gateway,
        targetScope,
        fence,
        null,
        "waiting",
      );
      const queued = gateway.mutate(
        submitRequest(
          targetScope,
          fence,
          acknowledgement,
          "queued-before-close",
        ),
      );
      const close = gateway.closeAndDrain({
        authorityId: "gateway-1",
        closeOperationId: "close-wins-wait",
        scope: targetScope,
      });
      await expect(queued).resolves.toMatchObject({
        outcome: "superseded",
        reason: "gateway_scope_closed",
      });
      await expect(close).resolves.toMatchObject({
        disposition: "drained",
        invalidatedQueueCount: 1,
      });
      expect(syntheticState(environment).mutationCalls).toBe(0);
    });
  },
);
