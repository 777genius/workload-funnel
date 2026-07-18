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
  executeSyntheticRead,
  installAndOpen,
  installAndKeepClosed,
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
  it("recovers a lost submit response by exact deterministic name without blind submit", async () => {
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
      reason: "authority_revalidation_required",
      recoveredUnknownOperations: [],
    });
    await expect(restarted.mutate(request)).resolves.toMatchObject({
      operationId: "submit-crash-window",
      outcome: "applied",
      reason: "hyperqueue_operation_name_correlated",
    });
    expect(syntheticState(environment).mutationCalls).toBe(1);
    expect(syntheticState(environment).lookupCalls).toBe(2);
  });

  it("correlates malformed submit output to one exact retained job", async () => {
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
      outcome: "applied",
      reason: "hyperqueue_operation_name_correlated",
    });
    await expect(gateway.mutate(request)).resolves.toEqual(receipt);
    expect(syntheticState(environment).mutationCalls).toBe(1);
    expect(syntheticState(environment).lookupCalls).toBe(2);
  });

  it("does not resubmit when lookup resolves a lost accepted submit response", async () => {
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
      outcome: "applied",
      reason: "hyperqueue_operation_name_correlated",
    });
    await expect(gateway.mutate(request)).resolves.toEqual(receipt);
    expect(syntheticState(environment).mutationCalls).toBe(1);
    expect(syntheticState(environment).lookupCalls).toBe(2);
  });

  it("recovers the create-only mapping fsync boundary without lookup or resubmit", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      faults: {
        afterMappingPersist() {
          throw new SimulatedGatewayCrash();
        },
      },
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-mapping-fsync");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-mapping-fsync",
      supersessionKey: "dispatch:dispatch-mapping-fsync",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "mapping-fsync",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-mapping-fsync",
    );
    await expect(gateway.mutate(request)).rejects.toThrow(
      "simulated_gateway_crash",
    );
    const durableKinds = readFileSync(environment.walPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          (
            JSON.parse(line) as {
              readonly record: { readonly kind: string };
            }
          ).record.kind,
      );
    expect(durableKinds.indexOf("cli_intent")).toBeLessThan(
      durableKinds.indexOf("dispatch_mapping"),
    );
    expect(durableKinds).not.toContain("effect_receipt");

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toMatchObject({
      reason: "authority_revalidation_required",
      recoveredUnknownOperations: [],
    });
    await expect(restarted.mutate(request)).resolves.toMatchObject({
      externalMappingOrInvocationId: "hq://1",
      outcome: "applied",
      reason: "gateway_recovered_durable_dispatch_mapping",
    });
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 1,
      mutationCalls: 1,
    });
  });

  it("recovers an HQ journal-retained job after gateway and scheduler restart", async () => {
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
    const targetScope = scope("dispatch_submit", "dispatch-journal-restart");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-journal-restart",
      supersessionKey: "dispatch:dispatch-journal-restart",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "journal-restart",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-journal-restart",
    );
    await expect(gateway.mutate(request)).rejects.toThrow(
      "simulated_gateway_crash",
    );
    await executeSyntheticRead(environment, [
      "fixture-server-restart",
      "after_flush",
    ]);

    const restarted = createSyntheticGateway(environment);
    await restarted.recovery.recover();
    await expect(restarted.mutate(request)).resolves.toMatchObject({
      outcome: "applied",
      reason: "hyperqueue_operation_name_correlated",
    });
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 2,
      mutationCalls: 1,
      serverEpoch: 2,
    });
  });

  it("keeps a journal-lost submit unknown after restart and never resubmits", async () => {
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
    const targetScope = scope("dispatch_submit", "dispatch-journal-lost");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-journal-lost",
      supersessionKey: "dispatch:dispatch-journal-lost",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "journal-lost",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-journal-lost",
    );
    await expect(gateway.mutate(request)).rejects.toThrow(
      "simulated_gateway_crash",
    );
    await executeSyntheticRead(environment, [
      "fixture-journal-restart",
      "lost_unflushed",
    ]);

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toEqual({
      mutationReady: false,
      observationReady: true,
      reason: "unresolved_cli_intent",
      recoveredUnknownOperations: ["submit-journal-lost"],
    });
    const receipt = await restarted.mutate(request);
    expect(receipt).toMatchObject({
      outcome: "unknown",
      reason: "ambiguous_submit_lookup_zero_matches",
    });
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 2,
      mutationCalls: 1,
      serverEpoch: 2,
    });
  });

  it.each([
    ["ambiguous_running", "running"],
    ["ambiguous_finished", "fast-terminal"],
    ["ambiguous_canceled", "canceled"],
  ] as const)(
    "correlates a retained %s job after an ambiguous submit (%s)",
    async (fixtureMode, state) => {
      expect(["running", "fast-terminal", "canceled"]).toContain(state);
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment, { fixtureMode });
      await gateway.recovery.recover();
      const dispatchId = `dispatch-${fixtureMode}`;
      const targetScope = scope("dispatch_submit", dispatchId);
      const fence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: `scheduler-dispatch:${dispatchId}`,
        supersessionKey: `dispatch:${dispatchId}`,
      });
      const acknowledgement = await installAndOpen(
        gateway,
        targetScope,
        fence,
        null,
        fixtureMode,
      );
      await expect(
        gateway.mutate(
          submitRequest(
            targetScope,
            fence,
            acknowledgement,
            `submit-${fixtureMode}`,
          ),
        ),
      ).resolves.toMatchObject({
        outcome: "applied",
        reason: "hyperqueue_operation_name_correlated",
      });
      expect(syntheticState(environment)).toMatchObject({
        lookupCalls: 2,
        mutationCalls: 1,
      });
    },
  );

  it.each([
    ["ambiguous_zero", "ambiguous_submit_lookup_zero_matches"],
    ["ambiguous_duplicate", "ambiguous_submit_lookup_multiple_matches"],
    ["ambiguous_malformed_lookup", "ambiguous_submit_lookup_malformed"],
    ["ambiguous_oversized_lookup", "ambiguous_submit_lookup_oversized"],
    ["ambiguous_incomplete_lookup", "ambiguous_submit_lookup_incomplete"],
  ] as const)(
    "cordons and retains an unresolved %s lookup without automatic resubmit",
    async (fixtureMode, reason) => {
      const environment = createSyntheticGatewayEnvironment();
      environments.push(environment);
      const gateway = createSyntheticGateway(environment, { fixtureMode });
      await gateway.recovery.recover();
      const dispatchId = `dispatch-${fixtureMode}`;
      const targetScope = scope("dispatch_submit", dispatchId);
      const fence = schedulerFence("dispatch_submit", 1, {
        effectScopeKey: `scheduler-dispatch:${dispatchId}`,
        supersessionKey: `dispatch:${dispatchId}`,
      });
      const acknowledgement = await installAndOpen(
        gateway,
        targetScope,
        fence,
        null,
        fixtureMode,
      );
      const request = submitRequest(
        targetScope,
        fence,
        acknowledgement,
        `submit-${fixtureMode}`,
      );
      const receipt = await gateway.mutate(request);
      expect(receipt).toMatchObject({ outcome: "unknown", reason });
      await expect(gateway.mutate(request)).resolves.toEqual(receipt);
      const beforeRestart = syntheticState(environment);

      const restarted = createSyntheticGateway(environment, { fixtureMode });
      await expect(restarted.recovery.recover()).resolves.toEqual({
        mutationReady: false,
        observationReady: true,
        reason: "unresolved_cli_intent",
        recoveredUnknownOperations: [`submit-${fixtureMode}`],
      });
      await expect(restarted.mutate(request)).resolves.toEqual(receipt);
      expect(syntheticState(environment)).toMatchObject({
        lookupCalls: beforeRestart.lookupCalls,
        mutationCalls: beforeRestart.mutationCalls,
      });
    },
  );

  it("serializes concurrent replay around one ambiguous submit and one lookup", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      fixtureMode: "partition_after_submit",
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-concurrent-lookup");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-concurrent-lookup",
      supersessionKey: "dispatch:dispatch-concurrent-lookup",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "concurrent-lookup",
    );
    const request = submitRequest(
      targetScope,
      fence,
      acknowledgement,
      "submit-concurrent-lookup",
    );
    const [first, second] = await Promise.all([
      gateway.mutate(request),
      gateway.mutate(request),
    ]);
    expect(second).toEqual(first);
    expect(first.outcome).toBe("applied");
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 2,
      mutationCalls: 1,
    });
  });

  it("keeps an unresolved zero-match operation fenced across authority advance", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment, {
      fixtureMode: "ambiguous_zero",
    });
    await gateway.recovery.recover();
    const targetScope = scope("dispatch_submit", "dispatch-retained-unknown");
    const fence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-retained-unknown",
      supersessionKey: "dispatch:dispatch-retained-unknown",
    });
    const acknowledgement = await installAndOpen(
      gateway,
      targetScope,
      fence,
      null,
      "retained-unknown",
    );
    await expect(
      gateway.mutate(
        submitRequest(
          targetScope,
          fence,
          acknowledgement,
          "submit-retained-unknown",
        ),
      ),
    ).resolves.toMatchObject({ outcome: "unknown" });
    const advancedFence = Object.freeze({
      ...fence,
      expectedDesiredVersion: 2,
    });
    const advanced = await installAndKeepClosed(
      gateway,
      targetScope,
      advancedFence,
      fingerprintMutationFence(fence),
      "retained-unknown-advance",
    );
    expect(advanced.claims.drainDisposition).toBe("unresolved");
    await expect(
      gateway.reopen({
        acknowledgement: advanced,
        reopenOperationId: "reopen-retained-unknown-advanced",
      }),
    ).rejects.toThrow("invalid_gateway_request:reopen_ack");
    expect(syntheticState(environment).mutationCalls).toBe(1);
  });

  it("rejects a conflicting create-only external mapping and cordons the operation", async () => {
    const environment = createSyntheticGatewayEnvironment();
    environments.push(environment);
    const gateway = createSyntheticGateway(environment);
    await gateway.recovery.recover();
    const firstScope = scope("dispatch_submit", "dispatch-mapping-first");
    const firstFence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-mapping-first",
      supersessionKey: "dispatch:dispatch-mapping-first",
    });
    const firstAck = await installAndOpen(
      gateway,
      firstScope,
      firstFence,
      null,
      "mapping-first",
    );
    await expect(
      gateway.mutate(
        submitRequest(firstScope, firstFence, firstAck, "submit-mapping-first"),
      ),
    ).resolves.toMatchObject({ outcome: "applied" });

    await executeSyntheticRead(environment, [
      "fixture-conflicting-next-submit",
    ]);
    const secondScope = scope("dispatch_submit", "dispatch-mapping-second");
    const secondFence = schedulerFence("dispatch_submit", 1, {
      effectScopeKey: "scheduler-dispatch:dispatch-mapping-second",
      supersessionKey: "dispatch:dispatch-mapping-second",
    });
    const secondAck = await installAndOpen(
      gateway,
      secondScope,
      secondFence,
      null,
      "mapping-second",
    );
    const secondRequest = submitRequest(
      secondScope,
      secondFence,
      secondAck,
      "submit-mapping-second",
    );
    await expect(gateway.mutate(secondRequest)).resolves.toMatchObject({
      outcome: "unknown",
      reason: "ambiguous_submit_mapping_conflict",
    });
    expect(syntheticState(environment)).toMatchObject({
      lookupCalls: 2,
      mutationCalls: 2,
    });

    const restarted = createSyntheticGateway(environment);
    await expect(restarted.recovery.recover()).resolves.toMatchObject({
      reason: "unresolved_cli_intent",
      recoveredUnknownOperations: ["submit-mapping-second"],
    });
    await expect(restarted.mutate(secondRequest)).resolves.toMatchObject({
      outcome: "unknown",
      reason: "ambiguous_submit_mapping_conflict",
    });
    expect(syntheticState(environment).mutationCalls).toBe(2);
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
