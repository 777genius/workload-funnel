import { describe, expect, it } from "vitest";

import {
  bearerTokenDigest,
  createTransportAuthenticator,
  TransportAuthenticationError,
} from "@workload-funnel/control-service/authentication";
import {
  createAuthorizationService,
  type ApiPermission,
} from "@workload-funnel/control-service/authorization";
import type { WorkloadSpec } from "@workload-funnel/workload-control/workload-lifecycle";

import { createPhase5TestFixture } from "./phase5-test-fixture.js";

const workloadSpec: WorkloadSpec = Object.freeze({
  command: Object.freeze(["synthetic"]),
  processProfile: "trusted-synthetic-v1",
  resources: Object.freeze({ cpuMillis: 100, memoryMiB: 64 }),
  resultFiles: Object.freeze([]),
  schemaVersion: 1,
  syntheticOutcome: "succeeded",
});

function body(extra: Readonly<Record<string, unknown>> = {}) {
  return {
    contractVersion: "workload-funnel.api/v1",
    mutation: {
      causationId: "cause-auth",
      contractVersion: "workload-funnel.mutation/v1",
      correlationId: "correlation-auth",
      idempotencyKey: "auth-submit",
      requestedTenantScope: "synthetic-tenant",
      requestId: "request-auth",
    },
    spec: workloadSpec,
    ...extra,
  };
}

describe("Phase 5 authentication, authorization, and cursor adversarial cases", () => {
  it("rejects ambiguous credentials and snapshots authorization policy revisions", () => {
    const tokenDigest = bearerTokenDigest("bounded-token");
    expect(() =>
      createTransportAuthenticator([
        {
          bearerTokenSha256: tokenDigest,
          credentialId: "credential-1",
          principalId: "principal-1",
        },
        {
          bearerTokenSha256: tokenDigest,
          credentialId: "credential-2",
          principalId: "principal-2",
        },
      ]),
    ).toThrow("invalid_transport_identity_binding");
    const authenticator = createTransportAuthenticator([
      {
        bearerTokenSha256: tokenDigest,
        credentialId: "credential-1",
        principalId: "principal-1",
      },
    ]);
    expect(() =>
      authenticator.authenticate(
        { kind: "bearer", token: "x".repeat(16_385) },
        1,
      ),
    ).toThrow(TransportAuthenticationError);

    const permissions = new Set<ApiPermission>(["workload.observe"]);
    const authorization = createAuthorizationService([
      {
        policyVersion: 1,
        principalId: "principal-1",
        tenantGrants: [{ permissions, tenantId: "tenant-1" }],
      },
    ]);
    permissions.add("workload.submit");
    expect(() =>
      authorization.authorize(
        {
          authenticatedAt: 1,
          credentialId: "credential-1",
          principalId: "principal-1",
        },
        {
          permission: "workload.submit",
          requestedTenantScope: "tenant-1",
        },
      ),
    ).toThrow("tenant_scope_denied");
  });

  it("authenticates transport identity before authorization and rejects caller identity fields", () => {
    const fixture = createPhase5TestFixture();
    const unauthenticated = fixture.api.handle({
      body: body(),
      credential: Object.freeze({ kind: "bearer", token: "wrong" }),
      method: "POST",
      path: "/v1/workloads",
    });
    expect(unauthenticated.status).toBe(401);

    const crossTenant = fixture.api.handle({
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "GET",
      path: "/v1/capacity",
      query: Object.freeze({ tenant: "another-tenant" }),
    });
    expect(crossTenant.status).toBe(403);

    const excessiveResources = fixture.api.handle({
      body: {
        ...body(),
        spec: {
          ...workloadSpec,
          resources: { cpuMillis: 9000, memoryMiB: 64 },
        },
      },
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "POST",
      path: "/v1/workloads",
    });
    expect(excessiveResources.status).toBe(403);

    const assertedActor = fixture.api.handle({
      body: body({ actorId: "forged-operator" }),
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "POST",
      path: "/v1/workloads",
    });
    expect(assertedActor.status).toBe(400);
    expect(JSON.stringify(assertedActor.body)).not.toContain(fixture.token);

    const nestedIdentity = fixture.api.handle({
      body: {
        ...body(),
        spec: { ...workloadSpec, actorId: "nested-forgery" },
      },
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "POST",
      path: "/v1/workloads",
    });
    expect(nestedIdentity.status).toBe(400);
  });

  it("rejects admission while degraded but keeps observation available", () => {
    const fixture = createPhase5TestFixture();
    fixture.setDependencyHealth(
      Object.freeze({
        admissionPath: "unsafe",
        cancellationPath: "available",
        canonicalStore: "available",
        internalLoop: "progressing",
        nodeSchedulability: Object.freeze({
          "synthetic-node-1": "schedulable",
        }),
        observationPath: "available",
        outboxPublisher: "progressing",
      }),
    );
    expect(
      fixture.api.handle({
        body: body(),
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "POST",
        path: "/v1/workloads",
      }),
    ).toMatchObject({
      body: { error: { code: "admission_unavailable" } },
      status: 503,
    });
    expect(
      fixture.api.handle({
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "GET",
        path: "/v1/capacity",
        query: Object.freeze({ tenant: "synthetic-tenant" }),
      }).status,
    ).toBe(200);
    expect(
      fixture.api.handle({ method: "GET", path: "/health" }),
    ).toMatchObject({
      body: { serviceMode: "degraded_observe_cancel_only" },
      status: 207,
    });
  });

  it("accepts additive optional v1 fields and rejects unsupported major or required contracts", () => {
    const fixture = createPhase5TestFixture();
    const credential = Object.freeze({
      kind: "bearer" as const,
      token: fixture.token,
    });
    expect(
      fixture.api.handle({
        body: body({ optionalFutureField: { value: true } }),
        credential,
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(202);
    const optionalSpec = body();
    expect(
      fixture.api.handle({
        body: {
          ...optionalSpec,
          mutation: {
            ...optionalSpec.mutation,
            idempotencyKey: "optional-spec-field",
          },
          spec: { ...workloadSpec, futureOptionalField: { value: true } },
        },
        credential,
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(202);
    expect(
      fixture.api.handle({
        body: { ...body(), contractVersion: "workload-funnel.api/v2" },
        credential,
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(422);
    const withRequiredExtension = body();
    expect(
      fixture.api.handle({
        body: {
          ...withRequiredExtension,
          mutation: {
            ...withRequiredExtension.mutation,
            idempotencyKey: "required-extension",
            requiredExtensions: ["requires-v2"],
          },
        },
        credential,
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(422);
    const first = body();
    expect(
      fixture.api.handle({
        body: {
          ...first,
          mutation: { ...first.mutation, idempotencyKey: "conflicting-spec" },
        },
        credential,
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(202);
    expect(
      fixture.api.handle({
        body: {
          ...first,
          mutation: { ...first.mutation, idempotencyKey: "conflicting-spec" },
          spec: { ...workloadSpec, syntheticOutcome: "failed" },
        },
        credential,
        method: "POST",
        path: "/v1/workloads",
      }),
    ).toMatchObject({
      body: { error: { code: "idempotency_key_conflict" } },
      status: 409,
    });
  });

  it("binds signed keyset cursors to tenant, filters, partition, schema, and snapshot watermark", async () => {
    const fixture = createPhase5TestFixture();
    const snapshot = await fixture.transport.request<{
      cursor: string;
      snapshotWatermark: number;
    }>({
      method: "GET",
      path: "/v1/snapshots/workloads",
      query: Object.freeze({
        partition: "control-1",
        tenant: "synthetic-tenant",
      }),
    });
    const tampered = `${snapshot.cursor.slice(0, -2)}aa`;
    const invalid = fixture.api.handle({
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "GET",
      path: "/v1/events",
      query: Object.freeze({
        cursor: tampered,
        partition: "control-1",
        snapshotWatermark: String(snapshot.snapshotWatermark),
        tenant: "synthetic-tenant",
      }),
    });
    expect(invalid.status).toBe(400);

    const rebound = fixture.api.handle({
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "GET",
      path: "/v1/events",
      query: Object.freeze({
        cursor: snapshot.cursor,
        partition: "control-1",
        snapshotWatermark: String(snapshot.snapshotWatermark),
        streamClass: "observation",
        tenant: "synthetic-tenant",
      }),
    });
    expect(rebound.status).toBe(400);

    fixture.advance(10_001);
    const expired = fixture.api.handle({
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "GET",
      path: "/v1/events",
      query: Object.freeze({
        cursor: snapshot.cursor,
        partition: "control-1",
        snapshotWatermark: String(snapshot.snapshotWatermark),
        tenant: "synthetic-tenant",
      }),
    });
    expect(expired.status).toBe(410);
    expect(expired.body).toMatchObject({
      error: {
        code: "cursor_expired",
        snapshotPath: "/v1/snapshots/workloads",
      },
    });
  });

  it("rejects conflicting consumer registration replays and compacted cursors", async () => {
    const fixture = createPhase5TestFixture();
    const snapshot = await fixture.transport.request<{
      cursor: string;
      snapshotWatermark: number;
    }>({
      method: "GET",
      path: "/v1/snapshots/workloads",
      query: Object.freeze({
        partition: "control-1",
        streamClass: "general",
        tenant: "synthetic-tenant",
      }),
    });
    const registration = {
      cursor: snapshot.cursor,
      limits: {
        batchSize: 10,
        leaseDurationMs: 1000,
        maximumBufferedBytes: 100_000,
        maximumBufferedCount: 100,
        maximumLag: 100,
        replayHorizonMs: 10_000,
      },
      mutation: {
        causationId: "consumer-cause",
        contractVersion: "workload-funnel.mutation/v1",
        correlationId: "consumer-correlation",
        idempotencyKey: "consumer-register-conflict",
        requestedTenantScope: "synthetic-tenant",
        requestId: "consumer-request",
      },
      partition: "control-1",
      snapshotWatermark: snapshot.snapshotWatermark,
      streamClass: "general",
    };
    expect(
      fixture.api.handle({
        body: { ...registration, consumerId: "consumer-a" },
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "POST",
        path: "/v1/event-consumers",
      }).status,
    ).toBe(201);
    expect(
      fixture.api.handle({
        body: { ...registration, consumerId: "consumer-b" },
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "POST",
        path: "/v1/event-consumers",
      }).status,
    ).toBe(409);

    expect(
      fixture.api.handle({
        body: body(),
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "POST",
        path: "/v1/workloads",
      }).status,
    ).toBe(202);
    fixture.advance(1001);
    expect(
      fixture.api.handle({
        credential: Object.freeze({ kind: "bearer", token: fixture.token }),
        method: "GET",
        path: "/v1/event-consumers/consumer-a",
        query: Object.freeze({ tenant: "synthetic-tenant" }),
      }).status,
    ).toBe(410);
    fixture.database.state.publicEventFeed.compactThrough("control-1", 1);
    const compacted = fixture.api.handle({
      credential: Object.freeze({ kind: "bearer", token: fixture.token }),
      method: "GET",
      path: "/v1/events",
      query: Object.freeze({
        cursor: snapshot.cursor,
        partition: "control-1",
        snapshotWatermark: String(snapshot.snapshotWatermark),
        streamClass: "general",
        tenant: "synthetic-tenant",
      }),
    });
    expect(compacted.status).toBe(410);
    expect(compacted.body).toMatchObject({
      error: {
        code: "cursor_expired",
        oldestAvailablePosition: 2,
        snapshotPath: "/v1/snapshots/workloads",
      },
    });
  });
});
