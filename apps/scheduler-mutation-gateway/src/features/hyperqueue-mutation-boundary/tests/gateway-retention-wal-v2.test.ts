import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

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

describe("Phase 7 retained history and WAL v2", { timeout: 20_000 }, () => {
  it("rejects a pre-operation-name WAL v1 without reinterpreting its jobs", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-wal-v1");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-wal-v1",
      supersessionKey: "dispatch:dispatch-wal-v1",
    });
    await installAndOpen(gateway, targetScope, fence, null, "wal-v1");
    const v2 = readFileSync(environment.walPath, "utf8");
    writeFileSync(
      environment.walPath,
      v2.replace('"schemaVersion":2', '"schemaVersion":1'),
      "utf8",
    );

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toEqual({
      mutationReady: false,
      observationReady: true,
      reason: "gateway_wal_migration_required",
      recoveredUnknownOperations: [],
    });
    expect(syntheticState(environment).mutationCalls).toBe(0);
  });

  it("checks retained-history capacity before submit and makes no second submit", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, { maxRetainedJobs: 1 });
    await gateway.recovery.recover();
    const firstScope = scope("dispatch_submit", "dispatch-history-first");
    const firstFence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-history-first",
      supersessionKey: "dispatch:dispatch-history-first",
    });
    const firstAck = await installAndOpen(
      gateway,
      firstScope,
      firstFence,
      null,
      "history-first",
    );
    await expect(
      gateway.mutate(
        submitRequest(firstScope, firstFence, firstAck, "history-first"),
      ),
    ).resolves.toMatchObject({ outcome: "applied" });

    const secondScope = scope("dispatch_submit", "dispatch-history-second");
    const secondFence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-history-second",
      supersessionKey: "dispatch:dispatch-history-second",
    });
    const secondAck = await installAndOpen(
      gateway,
      secondScope,
      secondFence,
      null,
      "history-second",
    );
    await expect(
      gateway.mutate(
        submitRequest(secondScope, secondFence, secondAck, "history-second"),
      ),
    ).resolves.toMatchObject({
      outcome: "rejected",
      reason: "hyperqueue_retained_history_ceiling_reached",
    });
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 2,
      mutationCalls: 1,
    });
  });

  it("reserves WAL headroom before submit", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, { walCapacity: 5 });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-wal-headroom");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-wal-headroom",
      supersessionKey: "dispatch:dispatch-wal-headroom",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "wal-headroom",
    );
    await expect(
      gateway.mutate(
        submitRequest(
          targetScope,
          fence,
          acknowledgement,
          "submit-wal-headroom",
        ),
      ),
    ).rejects.toThrow("gateway_wal_full");
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 0,
      mutationCalls: 0,
    });
  });
});
