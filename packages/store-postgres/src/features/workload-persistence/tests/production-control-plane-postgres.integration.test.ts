import { createHash, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { createAsyncPostgresAuditLedgerStore } from "../../audit-ledger-persistence/index.js";
import { createAsyncPostgresCapacityReservationStore } from "../../capacity-reservation-ledger-persistence/index.js";
import { createAsyncPostgresInboxStore } from "../../command-inbox/index.js";
import { createAsyncPostgresExecutionStore } from "../../execution-persistence/index.js";
import { createAsyncPostgresNamespaceOwnershipStore } from "../../namespace-ownership-persistence/index.js";
import { createAsyncPostgresNodeObservationStore } from "../../node-persistence/index.js";
import { createAsyncPostgresReconciliationStore } from "../../reconciliation-claims/index.js";
import { migratePostgresLifecycleSchema } from "../../schema-migrations/index.js";
import { createAsyncPostgresOutboxStore } from "../../transactional-outbox/index.js";
import {
  authenticatedCallerScope,
  createAsyncWorkloadLifecycleService,
} from "@workload-funnel/workload-control/workload-lifecycle";

import { createPostgresLifecycleDatabase } from "../index.js";

const connectionString = process.env["WF_CONTROL_POSTGRES_TEST_URL"];
const describePostgres =
  connectionString === undefined ? describe.skip : describe;
const opened: ReturnType<typeof createPostgresLifecycleDatabase>[] = [];
const schemas = new Set<string>();

function connection() {
  if (connectionString === undefined)
    throw new Error("postgres_integration_url_missing");
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port);
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !/^wf_control_test_[a-z0-9_]{1,40}$/u.test(database) ||
    url.hostname.length === 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.username.length === 0 ||
    url.password.length === 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0
  )
    throw new Error("postgres_integration_url_unsafe");
  return Object.freeze({
    database,
    host: url.hostname,
    password: decodeURIComponent(url.password),
    port,
    user: decodeURIComponent(url.username),
  });
}

function schema(): string {
  const value = `wf_control_store_${randomUUID().replaceAll("-", "")}`;
  schemas.add(value);
  return value;
}

function database(
  schemaName: string,
  overrides: Readonly<{
    connectionTimeoutMs?: number;
    maxConnections?: number;
    queryTimeoutMs?: number;
  }> = {},
) {
  const value = connection();
  const queryTimeoutMs = overrides.queryTimeoutMs ?? 5_000;
  const result = createPostgresLifecycleDatabase({
    config: {
      applicationName: "workload-funnel-control-it",
      connectionTimeoutMs: overrides.connectionTimeoutMs ?? 1_000,
      database: value.database,
      host: value.host,
      idleTimeoutMs: 1_000,
      lockTimeoutMs: 1_000,
      maxConnections: overrides.maxConnections ?? 4,
      password: value.password,
      port: value.port,
      profile: "disposable-test",
      queryTimeoutMs,
      schema: schemaName,
      schemaOwner: value.user,
      shutdownTimeoutMs: 2_000,
      statementTimeoutMs: Math.min(4_000, queryTimeoutMs),
      tls: false,
      user: value.user,
    },
  });
  opened.push(result);
  return result;
}

async function migrate(
  value: ReturnType<typeof createPostgresLifecycleDatabase>,
) {
  return migratePostgresLifecycleSchema({
    executor: value.migrationExecutor,
    owner: value.schemaOwner,
    schema: value.schema,
  });
}

async function close(
  value: ReturnType<typeof createPostgresLifecycleDatabase>,
) {
  await value.close();
}

afterEach(async () => {
  await Promise.allSettled(opened.splice(0).map(close));
  for (const schemaName of schemas) {
    const cleanup = database(schemaName);
    try {
      await cleanup.queryExecutor.transaction((client) =>
        client.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`),
      );
    } finally {
      await cleanup.close();
      opened.splice(opened.indexOf(cleanup), 1);
    }
  }
  schemas.clear();
});

const principal = Object.freeze({
  namespaceId: "control-namespace",
  principalId: "control-principal",
  tenantId: "control-tenant",
});

function spec(command: string) {
  return Object.freeze({
    command: Object.freeze([command]),
    processProfile: "trusted-synthetic-v1",
    resources: Object.freeze({ cpuMillis: 100, memoryMiB: 64 }),
    resultFiles: Object.freeze([]),
    schemaVersion: 1 as const,
    syntheticOutcome: "succeeded" as const,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describePostgres("production control-plane Postgres integration", () => {
  it("persists canonical bundles and rejects stale multi-writer fences across restart", async () => {
    const schemaName = schema();
    const left = database(schemaName);
    const right = database(schemaName);
    await Promise.all([migrate(left), migrate(right)]);
    const lifecycle = createAsyncWorkloadLifecycleService(left.repository);
    const receipt = await lifecycle.submit(principal, {
      idempotencyKey: "integration-submit",
      spec: spec("integration"),
    });
    await expect(
      lifecycle.submit(principal, {
        idempotencyKey: "integration-submit",
        spec: spec("integration"),
      }),
    ).resolves.toEqual(receipt);

    const delimiterLeft = Object.freeze({
      namespaceId: "delimiter:a",
      principalId: "b",
      tenantId: "delimiter-tenant",
    });
    const delimiterRight = Object.freeze({
      namespaceId: "delimiter",
      principalId: "a:b",
      tenantId: "delimiter-tenant",
    });
    expect(`${delimiterLeft.namespaceId}:${delimiterLeft.principalId}`).toBe(
      `${delimiterRight.namespaceId}:${delimiterRight.principalId}`,
    );
    expect(authenticatedCallerScope(delimiterLeft)).not.toBe(
      authenticatedCallerScope(delimiterRight),
    );
    const delimiterReceipts = await Promise.all(
      [delimiterLeft, delimiterRight].map((identity) =>
        lifecycle.submit(identity, {
          idempotencyKey: "same-key",
          spec: spec("delimiter"),
        }),
      ),
    );
    expect(delimiterReceipts[0]?.operationId).not.toBe(
      delimiterReceipts[1]?.operationId,
    );
    await expect(
      lifecycle.status(
        { ...principal, tenantId: "cross-tenant" },
        receipt.runId,
      ),
    ).resolves.toBeUndefined();

    const cancellation = await lifecycle.cancel(
      principal,
      receipt.runId,
      "integration-cancel",
    );
    await expect(
      lifecycle.cancel(principal, receipt.runId, "integration-cancel"),
    ).resolves.toEqual(cancellation);
    const erasure = Object.freeze({
      operationId: "integration-erasure",
      pseudonym: "control-principal-erased",
      subjectPrincipalId: principal.principalId,
    });
    await expect(
      lifecycle.erasePrincipalReferences(principal, erasure),
    ).resolves.toBe(1);
    await expect(
      lifecycle.erasePrincipalReferences(principal, erasure),
    ).resolves.toBe(1);
    await expect(
      lifecycle.erasePrincipalReferences(principal, {
        ...erasure,
        pseudonym: "different-pseudonym",
      }),
    ).rejects.toMatchObject({
      code: "postgres_lifecycle_idempotency_conflict",
    });

    const executor = left.queryExecutor;
    const audit = createAsyncPostgresAuditLedgerStore(executor, schemaName);
    const capacity = createAsyncPostgresCapacityReservationStore(
      executor,
      schemaName,
    );
    const executions = createAsyncPostgresExecutionStore(executor, schemaName);
    const inbox = createAsyncPostgresInboxStore(executor, schemaName);
    const namespaces = createAsyncPostgresNamespaceOwnershipStore(
      executor,
      schemaName,
    );
    const nodes = createAsyncPostgresNodeObservationStore(executor, schemaName);
    const outbox = createAsyncPostgresOutboxStore(executor, schemaName);
    const reconciliation = createAsyncPostgresReconciliationStore(
      executor,
      schemaName,
    );
    await Promise.all([
      audit.ready(),
      capacity.ready(),
      executions.ready(),
      inbox.ready(),
      namespaces.ready(),
      nodes.ready(),
      outbox.ready(),
      reconciliation.ready(),
    ]);
    await namespaces.create({
      namespaceId: principal.namespaceId,
      payload: Object.freeze({ deployment: "control-it" }),
      version: 1,
      writerEpoch: 7,
      writerId: "writer-a",
    });
    await capacity.ensureProfile({
      capacityId: "capacity-1",
      totalCpuMillis: 1_000,
      totalMemoryMiB: 1_024,
    });
    const allocation = await capacity.reserve({
      allocationId: "allocation-1",
      attemptId: receipt.attemptId,
      capacityId: "capacity-1",
      cpuMillis: 100,
      executionGeneration: receipt.executionGeneration,
      memoryMiB: 64,
      nodeId: "node-1",
    });
    const now = Date.now();
    const claimed = await capacity.claim(
      allocation.allocationId,
      "owner-a",
      0,
      now,
      now + 60_000,
    );
    const active = await capacity.activate(
      allocation.allocationId,
      claimed.version,
    );
    const execution = await executions.create({
      allocationId: allocation.allocationId,
      attemptId: receipt.attemptId,
      executionGeneration: receipt.executionGeneration,
      executionId: "execution-1",
      namespaceId: principal.namespaceId,
      ownerFence: claimed.ownerFence,
      ownerId: "owner-a",
      payload: Object.freeze({ processIdentity: "process-1" }),
      state: "starting",
      version: 1,
      writerEpoch: 7,
    });
    const runningPayload = Object.freeze({ state: "running" });
    await executions.recordObservation({
      executionGeneration: execution.executionGeneration,
      executionId: execution.executionId,
      namespaceId: execution.namespaceId,
      observationDigest: digest(runningPayload),
      ownerFence: execution.ownerFence,
      payload: runningPayload,
      sourceId: "node-1",
      sourceSequence: 1,
      state: "running",
      writerEpoch: execution.writerEpoch,
    });
    await nodes.record({
      bootEpoch: "boot-1",
      nodeId: "node-1",
      payload: Object.freeze({ pressure: "normal" }),
      sourceSequence: 1,
      version: 1,
    });
    const work = await reconciliation.create({
      kind: "execution-observation",
      operationId: "reconciliation-1",
      payload: Object.freeze({ executionId: execution.executionId }),
      state: "pending",
      version: 1,
    });
    const workNow = Date.now();
    const workClaim = await reconciliation.claim(
      work.operationId,
      "reconciler-a",
      0,
      workNow,
      workNow + 60_000,
    );
    await reconciliation.compareAndSet(
      workClaim.version,
      {
        ...workClaim,
        payload: Object.freeze({ executionId: execution.executionId }),
        state: "observed",
        version: workClaim.version + 1,
      },
      {
        claimantId: workClaim.claim?.claimantId ?? "missing",
        fence: workClaim.claim?.fence ?? -1,
      },
      workNow,
    );

    const deliveries = await outbox.claim(
      "delivery-a",
      Date.now(),
      Date.now() + 60_000,
      10,
    );
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries)
      await outbox.acknowledge(
        delivery.messageId,
        delivery.deliveryOwner,
        delivery.deliveryFence,
        Date.now(),
      );
    await expect(audit.page(principal.tenantId, 0, 100)).resolves.toHaveLength(
      3,
    );
    await expect(
      inbox.get("control-api", receipt.operationId),
    ).resolves.toMatchObject({ operationKind: "submit" });
    await expect(
      inbox.get("control-api", cancellation.operationId),
    ).resolves.toMatchObject({ operationKind: "cancel" });
    await expect(
      inbox.get("control-api", erasure.operationId),
    ).resolves.toMatchObject({ operationKind: "erasure" });
    await left.queryExecutor.transaction(async (client) => {
      await client.query(
        `INSERT INTO ${schemaName}.control_service_identity
             (identity_id, identity_kind, credential_id,
              credential_fingerprint, state, version, payload)
           VALUES ($1, 'mtls-client', $2, $3, 'active', 1, '{}'::jsonb)`,
        [
          principal.principalId,
          "credential-1",
          Array.from({ length: 32 }, () => "AA").join(":"),
        ],
      );
      await client.query(
        `UPDATE ${schemaName}.control_allocation SET lease_until = $2
            WHERE allocation_id = $1`,
        [allocation.allocationId, Date.now() - 1],
      );
    });
    const takeoverNow = Date.now();
    const takeover = await capacity.claim(
      allocation.allocationId,
      "owner-b",
      claimed.ownerFence,
      takeoverNow,
      takeoverNow + 60_000,
    );
    const stalePayload = Object.freeze({ state: "unknown" });
    await expect(
      executions.recordObservation({
        executionGeneration: execution.executionGeneration,
        executionId: execution.executionId,
        namespaceId: execution.namespaceId,
        observationDigest: digest(stalePayload),
        ownerFence: execution.ownerFence,
        payload: stalePayload,
        sourceId: "node-1",
        sourceSequence: 2,
        state: "unknown",
        writerEpoch: execution.writerEpoch,
      }),
    ).rejects.toThrow("postgres_observation_stale_allocation_fence");
    const adopted = await executions.takeOwnership(
      execution.executionId,
      execution.ownerFence,
      "owner-b",
      takeover.ownerFence,
    );
    await executions.recordObservation({
      executionGeneration: adopted.executionGeneration,
      executionId: adopted.executionId,
      namespaceId: adopted.namespaceId,
      observationDigest: digest(stalePayload),
      ownerFence: adopted.ownerFence,
      payload: stalePayload,
      sourceId: "node-1",
      sourceSequence: 2,
      state: "unknown",
      writerEpoch: adopted.writerEpoch,
    });

    const competingNamespaces = [
      createAsyncPostgresNamespaceOwnershipStore(
        left.queryExecutor,
        schemaName,
      ),
      createAsyncPostgresNamespaceOwnershipStore(
        right.queryExecutor,
        schemaName,
      ),
    ];
    const namespaceResults = await Promise.allSettled(
      competingNamespaces.map((store, index) =>
        store.compareAndSet(principal.namespaceId, 1, 7, {
          namespaceId: principal.namespaceId,
          payload: Object.freeze({
            deployment: `control-it-${String(index)}`,
          }),
          version: 2,
          writerEpoch: 8,
          writerId: `writer-${String(index + 2)}`,
        }),
      ),
    );
    expect(
      namespaceResults.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      namespaceResults.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);

    await Promise.all([left.close(), right.close()]);
    const restarted = database(schemaName);
    await migrate(restarted);
    const restartedLifecycle = createAsyncWorkloadLifecycleService(
      restarted.repository,
    );
    await expect(
      restartedLifecycle.status(principal, receipt.runId),
    ).resolves.toMatchObject({ run: { runId: receipt.runId } });
    const restartedCapacity = createAsyncPostgresCapacityReservationStore(
      restarted.queryExecutor,
      schemaName,
    );
    await expect(
      restartedCapacity.snapshot("capacity-1"),
    ).resolves.toMatchObject({ reservedCpuMillis: active.cpuMillis });
    await expect(
      createAsyncPostgresNamespaceOwnershipStore(
        restarted.queryExecutor,
        schemaName,
      ).get(principal.namespaceId),
    ).resolves.toMatchObject({ version: 2, writerEpoch: 8 });
    await expect(
      createAsyncPostgresExecutionStore(
        restarted.queryExecutor,
        schemaName,
      ).get(execution.executionId),
    ).resolves.toMatchObject({ ownerFence: 2, ownerId: "owner-b" });
    await expect(
      createAsyncPostgresNodeObservationStore(
        restarted.queryExecutor,
        schemaName,
      ).get("node-1"),
    ).resolves.toMatchObject({ bootEpoch: "boot-1" });
    await expect(
      createAsyncPostgresReconciliationStore(
        restarted.queryExecutor,
        schemaName,
      ).listIncomplete(10),
    ).resolves.toHaveLength(1);
    await expect(
      createAsyncPostgresOutboxStore(restarted.queryExecutor, schemaName).claim(
        "delivery-b",
        Date.now(),
        Date.now() + 60_000,
        10,
      ),
    ).resolves.toEqual([]);
    await expect(
      restarted.queryExecutor.read(async (client) => {
        const result = await client.query<
          Record<string, unknown> & { bundle_count: number }
        >(
          `SELECT
               (SELECT count(*)::integer FROM ${schemaName}.control_inbox) +
               (SELECT count(*)::integer FROM ${schemaName}.control_audit) +
               (SELECT count(*)::integer FROM ${schemaName}.lifecycle_outbox) +
               (SELECT count(*)::integer FROM ${schemaName}.control_service_identity)
                 AS bundle_count`,
        );
        return result.rows[0]?.bundle_count;
      }),
    ).resolves.toBe(15);
    await restartedCapacity.release(
      allocation.allocationId,
      allocation.executionGeneration,
    );
    await expect(
      restartedCapacity.snapshot("capacity-1"),
    ).resolves.toMatchObject({ reservedCpuMillis: 0, reservedMemoryMiB: 0 });
  }, 20_000);

  it("bounds pool exhaustion, query abort, and checked-out cleanup", async () => {
    const schemaName = schema();
    const store = database(schemaName, {
      connectionTimeoutMs: 100,
      maxConnections: 1,
      queryTimeoutMs: 2_000,
    });
    await migrate(store);
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const slow = store.queryExecutor.read(async (client) => {
      startedResolve?.();
      await client.query("SELECT pg_sleep(0.4)");
    });
    await started;
    await expect(
      store.queryExecutor.read(() => Promise.resolve("unreachable")),
    ).rejects.toMatchObject({ code: "postgres_lifecycle_pool_timeout" });
    await slow;

    const controller = new AbortController();
    const aborted = store.queryExecutor.read(
      (client) => client.query("SELECT pg_sleep(5)", [], controller.signal),
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 50).unref();
    await expect(aborted).rejects.toMatchObject({
      code: "postgres_lifecycle_aborted",
    });
    await expect(
      store.queryExecutor.read(async (client) => {
        await client.query("SELECT 1");
        return true;
      }),
    ).resolves.toBe(true);

    let activeResolve: (() => void) | undefined;
    const activeStarted = new Promise<void>((resolve) => {
      activeResolve = resolve;
    });
    const activeQuery = store.queryExecutor.read(async (client) => {
      activeResolve?.();
      await client.query("SELECT pg_sleep(5)");
    });
    await activeStarted;
    const closing = store.close();
    await expect(activeQuery).rejects.toMatchObject({
      code: "postgres_lifecycle_closed",
    });
    await expect(closing).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  }, 10_000);
});
