import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { fingerprintMutationFence } from "@workload-funnel/kernel";
import { SimulatedGatewayCrash } from "@workload-funnel/scheduler-mutation-gateway/hyperqueue-mutation-boundary";

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

describe("Phase 7 scheduler gateway recovery", { timeout: 20_000 }, () => {
  it("recovers an issued CLI call as one durable unknown without blind submit", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      faults: {
        afterCliCall() {
          throw new SimulatedGatewayCrash();
        },
      },
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-crash");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-crash",
      supersessionKey: "dispatch:dispatch-crash",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "crash",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-crash-window",
    );
    await expect(gateway.mutate(request)).rejects.toThrow(
      "simulated_gateway_crash",
    );
    expect(syntheticState(environment).mutationCalls).toBe(1);

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toEqual({
      mutationReady: false,
      observationReady: true,
      reason: "unresolved_cli_intent",
      recoveredUnknownOperations: ["submit-crash-window"],
    });
    await expect(restarted.mutate(request)).resolves.toMatchObject({
      operationId: "submit-crash-window",
      outcome: "unknown",
      reason: "gateway_recovered_unresolved_cli_intent",
    });
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });

  it("persists malformed mutation output as unknown without retrying", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      fixtureMode: "malformed_submit",
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-malformed");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-malformed",
      supersessionKey: "dispatch:dispatch-malformed",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "malformed",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-malformed-output",
    );
    const receipt = await gateway.mutate(request);
    expect(receipt).toMatchObject({
      operationId: "submit-malformed-output",
      outcome: "unknown",
      reason: "hyperqueue_cli_outcome_ambiguous",
    });
    await expect(gateway.mutate(request)).resolves.toEqual(receipt);
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });

  it("does not retry when a synthetic network partition loses the accepted submit response", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      fixtureMode: "partition_after_submit",
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-partition");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-partition",
      supersessionKey: "dispatch:dispatch-partition",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "partition",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-partitioned-response",
    );
    const receipt = await gateway.mutate(request);
    expect(receipt).toMatchObject({
      operationId: "submit-partitioned-response",
      outcome: "unknown",
      reason: "hyperqueue_cli_outcome_ambiguous",
    });
    await expect(gateway.mutate(request)).resolves.toEqual(receipt);
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });

  it("returns the exact durable applied receipt after response loss and restart", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-receipt-replay");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-receipt-replay",
      supersessionKey: "dispatch:dispatch-receipt-replay",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "receipt-replay",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-receipt-replay",
    );
    const receipt = await gateway.mutate(request);
    expect(receipt.outcome).toBe("applied");
    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toMatchObject({
      mutationReady: false,
      reason: "authority_revalidation_required",
    });
    await expect(restarted.mutate(request)).resolves.toEqual(receipt);
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });

  it("cordons mutation when a valid WAL prefix is rolled back behind its durable checkpoint", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-wal-rollback");
    const firstFence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-wal-rollback",
      supersessionKey: "dispatch:dispatch-wal-rollback",
    });
    await installAndOpen(
      gateway,
      targetScope,
      firstFence,
      null,
      "wal-rollback-first",
    );
    const oldWal = readFileSync(environment.walPath, "utf8");
    const secondFence = Object.freeze({
      ...firstFence,
      expectedDesiredVersion: 2,
    });
    await installAndOpen(
      gateway,
      targetScope,
      secondFence,
      fingerprintMutationFence(firstFence),
      "wal-rollback-second",
    );
    writeFileSync(environment.walPath, oldWal, "utf8");
    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toEqual({
      mutationReady: false,
      observationReady: true,
      reason: "gateway_registry_unprovable",
      recoveredUnknownOperations: [],
    });
    expect(syntheticState(environment).mutationCalls).toBe(0);
  });

  it("keeps observation available and mutation cordoned after WAL corruption", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    writeFileSync(environment.walPath, "{truncated\n", { mode: 0o600 });

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toEqual({
      mutationReady: false,
      observationReady: true,
      reason: "gateway_registry_unprovable",
      recoveredUnknownOperations: [],
    });
    expect(syntheticState(environment).mutationCalls).toBe(0);
  });

  it("fails exact-version preflight closed without a mutation call", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, { version: "0.26.3" });
    await expect(gateway.recovery.recover()).resolves.toMatchObject({
      mutationReady: false,
      reason: "release_preflight_failed",
    });
    expect(syntheticState(environment).mutationCalls).toBe(0);
  });

  it("rejects a replaced scheduler credential directory before any CLI call", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-custody-swap");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-custody-swap",
      supersessionKey: "dispatch:dispatch-custody-swap",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "custody-swap",
    );
    const originalDirectory = `${environment.schedulerDirectory}-original`;
    renameSync(environment.schedulerDirectory, originalDirectory);
    mkdirSync(environment.schedulerDirectory, { mode: 0o700 });
    await expect(
      gateway.mutate(
        submitRequest(
          targetScope,
          fence,
          acknowledgement,
          "submit-after-custody-swap",
        ),
      ),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: "hyperqueue_credential_custody_changed",
    });
    const priorState = JSON.parse(
      readFileSync(join(originalDirectory, "scheduler.json"), "utf8"),
    ) as { readonly mutationCalls: number };
    expect(priorState.mutationCalls).toBe(0);
  });
});
