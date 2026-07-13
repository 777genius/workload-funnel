import {
  bearerTokenDigest,
  createTransportAuthenticator,
} from "@workload-funnel/control-service/authentication";
import {
  createAuthorizationService,
  type ApiPermission,
} from "@workload-funnel/control-service/authorization";
import { createCapacityController } from "@workload-funnel/control-service/node-controller";
import {
  createPhase1SyntheticService,
  createPhase5SyntheticPublicOperations,
  createSyntheticDatabase,
  type SyntheticArtifactWriter,
} from "@workload-funnel/control-service/phase1-synthetic-runtime";
import { createReconciliationController } from "@workload-funnel/control-service/reconciliation-controller";
import { createResultOperationsController } from "@workload-funnel/control-service/result-controller";
import {
  createPublicHttpApi,
  createSignedCursorCodec,
} from "@workload-funnel/control-service/transport-http";
import { createPublicWorkloadController } from "@workload-funnel/control-service/workload-controller";
import type {
  SdkHttpRequest,
  SdkHttpTransport,
} from "@workload-funnel/client-sdk/workload-submission";
import { WorkloadFunnelApiError } from "@workload-funnel/client-sdk/workload-submission";
import { createStructuredRedactor } from "@workload-funnel/observability/redaction-policy";
import {
  createServiceOperationsAdapter,
  createTelemetryProvider,
  type DependencyHealth,
  evaluateServiceHealth,
} from "@workload-funnel/observability/telemetry-export";

const permissions = new Set<ApiPermission>([
  "workload.submit",
  "workload.observe",
  "workload.cancel",
  "operation.observe",
  "result.observe",
  "capacity.observe",
  "explanation.observe",
  "events.observe",
  "consumer.manage",
  "retention.manage",
  "erasure.manage",
  "audit.observe",
  "reconciliation.observe",
  "metrics.observe",
]);

export function createPhase5TestFixture() {
  const token = "synthetic-phase5-token";
  const artifactWriter: SyntheticArtifactWriter = {
    root: "/synthetic/phase5-results",
    write: (command) =>
      `/synthetic/phase5-results/${command.attemptId}/${command.path}`,
  };
  const database = createSyntheticDatabase(
    "sqlite",
    Object.freeze(artifactWriter),
  );
  const service = createPhase1SyntheticService(database);
  let now = 1_783_900_801_000;
  const clock = () => now;
  const operations = createPhase5SyntheticPublicOperations(
    service,
    database,
    clock,
  );
  const redactor = createStructuredRedactor({
    maximumArrayLength: 32,
    maximumDepth: 8,
    maximumStringLength: 256,
    policyVersion: 1,
    secretKeys: new Set(["apiKey"]),
    sensitiveKeys: new Set(["prompt"]),
  });
  const telemetry = createTelemetryProvider(
    Object.freeze({
      log: () => undefined,
      metric: () => undefined,
      span: () => undefined,
    }),
    redactor,
  );
  let dependencyHealth: DependencyHealth = Object.freeze({
    admissionPath: "available",
    cancellationPath: "available",
    canonicalStore: "available",
    internalLoop: "progressing",
    nodeSchedulability: Object.freeze({
      "synthetic-node-1": "schedulable",
    }),
    observationPath: "available",
    outboxPublisher: "progressing",
  });
  const serviceOperations = createServiceOperationsAdapter({
    clock,
    health: () => evaluateServiceHealth(dependencyHealth),
    telemetry,
  });
  const api = createPublicHttpApi({
    authenticator: createTransportAuthenticator([
      Object.freeze({
        bearerTokenSha256: bearerTokenDigest(token),
        credentialId: "phase5-test-token",
        principalId: "synthetic-principal",
      }),
    ]),
    authorization: createAuthorizationService([
      Object.freeze({
        policyVersion: 7,
        principalId: "synthetic-principal",
        tenantGrants: Object.freeze([
          Object.freeze({
            allowedWorkloadProfiles: new Set(["trusted-synthetic-v1"]),
            maximumCpuMillis: 8000,
            maximumMemoryMiB: 16_384,
            permissions,
            tenantId: "synthetic-tenant",
          }),
        ]),
      }),
    ]),
    capacity: createCapacityController(operations.capacity),
    clock,
    cursorCodec: createSignedCursorCodec(
      {
        keys: Object.freeze([
          Object.freeze({
            keyId: "cursor-key-1",
            notAfter: now + 100_000,
            notBefore: now - 1000,
            secret: new Uint8Array(32).fill(17),
            sign: true,
          }),
        ]),
        keysetVersion: 1,
      },
      10_000,
    ),
    events: operations.events,
    reconciliation: createReconciliationController(operations.reconciliation),
    results: createResultOperationsController(operations.results),
    serviceOperations,
    workloads: createPublicWorkloadController(operations.workloads),
  });

  const transport: SdkHttpTransport = {
    request<T>(request: SdkHttpRequest): Promise<T> {
      const result = api.handle({
        ...request,
        credential: Object.freeze({ kind: "bearer", token }),
      });
      if (result.status >= 400) {
        const error = result.body as { error?: { code?: string } };
        return Promise.reject(
          new WorkloadFunnelApiError(
            result.status,
            error.error?.code ?? "api_error",
            result.body,
          ),
        );
      }
      return Promise.resolve(result.body as T);
    },
  };

  return {
    api,
    database,
    operations,
    redactor,
    service,
    telemetry,
    token,
    transport: Object.freeze(transport),
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    setDependencyHealth(next: DependencyHealth) {
      dependencyHealth = Object.freeze({
        ...next,
        nodeSchedulability: Object.freeze({ ...next.nodeSchedulability }),
      });
    },
  };
}
