import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { MutationFence } from "@workload-funnel/kernel";

import {
  createSyntheticGateway,
  createSyntheticGatewayEnvironment,
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

describe("Phase 7 closed scheduler fence boundary", { timeout: 20_000 }, () => {
  it("rejects every missing applicable fence component and unknown fence field with zero CLI calls", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-closed-fence");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-closed-fence",
      supersessionKey: "dispatch:dispatch-closed-fence",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "closed-fence",
    );
    const requiredFields: readonly (keyof MutationFence)[] = [
      "allocationId",
      "attemptId",
      "clusterIncarnation",
      "clusterIncarnationVersion",
      "desiredEffect",
      "effectScopeKey",
      "executionGeneration",
      "expectedDesiredVersion",
      "issuedStartRevocationRevision",
      "namespaceId",
      "namespaceWriterEpoch",
      "operationGateRevision",
      "ownerFence",
      "requiredGate",
      "schemaVersion",
      "startFence",
      "supersessionKey",
    ];
    for (const field of requiredFields) {
      const missing = Object.fromEntries(
        Object.entries(fence).filter(([key]) => key !== field),
      );
      const request = {
        ...submitRequest(
          targetScope,
          fence,
          acknowledgement,
          `missing-${field}`,
        ),
        mutationFence: missing,
      };
      await expect(gateway.mutate(request as never)).rejects.toThrow(
        /^(invalid_gateway_request|invalid_mutation_fence)/u,
      );
    }
    const extraFenceField = {
      ...submitRequest(
        targetScope,
        fence,
        acknowledgement,
        "extra-fence-field",
      ),
      mutationFence: { ...fence, untrustedAuthority: 1 },
    };
    await expect(gateway.mutate(extraFenceField as never)).rejects.toThrow(
      "invalid_gateway_request:mutation_fence",
    );
    const mismatchedFingerprint = {
      ...submitRequest(
        targetScope,
        fence,
        acknowledgement,
        "mismatched-fingerprint",
      ),
      mutationFenceFingerprint: `fence-v1-${"0".repeat(64)}`,
    };
    await expect(gateway.mutate(mismatchedFingerprint)).rejects.toThrow(
      "invalid_gateway_request:fingerprint",
    );
    expect(syntheticState(environment).mutationCalls).toBe(0);
  });
});
