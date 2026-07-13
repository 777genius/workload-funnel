import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

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

describe("Phase 7 scheduler gateway cross-scope identity mismatches", () => {
  it("rejects an equal owner fence bound to another Attempt without changing the installed maximum", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();

    const scopeA = scope("dispatch_submit", "dispatch-owner-a");
    const fenceA = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-owner-a",
      supersessionKey: "dispatch:dispatch-owner-a",
    });
    const acknowledgementA = await installAndOpen(
      gateway,
      scopeA,
      fenceA,
      null,
      "owner-a",
    );
    const scopeB = Object.freeze({
      ...scope("dispatch_submit", "dispatch-owner-b"),
      attemptId: "attempt-2",
      executionGeneration: "generation-2",
    });
    const mismatchedFenceB = schedulerFence("dispatch_submit", 1, {
      attemptId: "attempt-2",
      effectScopeKey: "scheduler-dispatch:dispatch-owner-b",
      executionGeneration: "generation-2",
      supersessionKey: "dispatch:dispatch-owner-b",
    });

    await expect(
      installAndKeepClosed(
        gateway,
        scopeB,
        mismatchedFenceB,
        null,
        "owner-b-mismatch",
      ),
    ).resolves.toMatchObject({
      claims: {
        comparisonResult: "equal_version_mismatch",
        result: "rejected",
      },
    });
    expect(syntheticState(environment).mutationCalls).toBe(0);

    await expect(
      gateway.mutate(
        submitRequest(scopeA, fenceA, acknowledgementA, "owner-a-submit"),
      ),
    ).resolves.toMatchObject({ outcome: "applied" });
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });
});
