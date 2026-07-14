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
  type Phase1SyntheticService,
} from "@workload-funnel/control-service/phase1-synthetic-runtime";
import { createReconciliationController } from "@workload-funnel/control-service/reconciliation-controller";
import { createResultOperationsController } from "@workload-funnel/control-service/result-controller";
import {
  createPublicHttpApi,
  createSignedCursorCodec,
} from "@workload-funnel/control-service/transport-http";
import { createPublicWorkloadController } from "@workload-funnel/control-service/workload-controller";
import {
  WorkloadFunnelApiError,
  type SdkHttpRequest,
  type SdkHttpTransport,
} from "@workload-funnel/client-sdk/workload-submission";
import { createStructuredRedactor } from "@workload-funnel/observability/redaction-policy";
import {
  createServiceOperationsAdapter,
  createTelemetryProvider,
  evaluateServiceHealth,
} from "@workload-funnel/observability/telemetry-export";

const permissions = new Set<ApiPermission>([
  "workload.submit",
  "workload.observe",
  "operation.observe",
  "result.observe",
  "capacity.observe",
  "explanation.observe",
]);

export interface ProductHarness {
  readonly database: ReturnType<typeof createSyntheticDatabase>;
  readonly service: Phase1SyntheticService;
  readonly transport: SdkHttpTransport;
  restart(): void;
}

export function createProductHarness(): ProductHarness {
  const database = createSyntheticDatabase("sqlite");
  const token = "full-lifecycle-e2e-token";
  const now = 1_800_000_001_500;
  let service: Phase1SyntheticService;
  let api: ReturnType<typeof createPublicHttpApi>;

  const transport: SdkHttpTransport = Object.freeze({
    request<T>(request: SdkHttpRequest): Promise<T> {
      const response = api.handle({
        ...request,
        credential: Object.freeze({ kind: "bearer", token }),
      });
      if (response.status >= 400) {
        const body = response.body as { error?: { code?: string } };
        return Promise.reject(
          new WorkloadFunnelApiError(
            response.status,
            body.error?.code ?? "api_error",
            response.body,
          ),
        );
      }
      return Promise.resolve(response.body as T);
    },
  });

  function restart(): void {
    service = createPhase1SyntheticService(database);
    const operations = createPhase5SyntheticPublicOperations(
      service,
      database,
      () => now,
    );
    const telemetry = createTelemetryProvider(
      Object.freeze({
        log: () => undefined,
        metric: () => undefined,
        span: () => undefined,
      }),
      createStructuredRedactor({
        maximumArrayLength: 32,
        maximumDepth: 8,
        maximumStringLength: 256,
        policyVersion: 1,
        secretKeys: new Set(["token"]),
        sensitiveKeys: new Set(["command"]),
      }),
    );
    api = createPublicHttpApi({
      authenticator: createTransportAuthenticator([
        Object.freeze({
          bearerTokenSha256: bearerTokenDigest(token),
          credentialId: "full-lifecycle-e2e-token",
          principalId: "synthetic-principal",
        }),
      ]),
      authorization: createAuthorizationService([
        Object.freeze({
          policyVersion: 1,
          principalId: "synthetic-principal",
          tenantGrants: Object.freeze([
            Object.freeze({
              allowedWorkloadProfiles: new Set(["trusted-synthetic-v1"]),
              maximumCpuMillis: 8_000,
              maximumMemoryMiB: 16_384,
              permissions,
              tenantId: "synthetic-tenant",
            }),
          ]),
        }),
      ]),
      capacity: createCapacityController(operations.capacity),
      clock: () => now,
      cursorCodec: createSignedCursorCodec(
        {
          keys: Object.freeze([
            Object.freeze({
              keyId: "full-lifecycle-cursor-key",
              notAfter: now + 100_000,
              notBefore: now - 1_000,
              secret: new Uint8Array(32).fill(23),
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
      serviceOperations: createServiceOperationsAdapter({
        clock: () => now,
        health: () =>
          evaluateServiceHealth({
            admissionPath: "available",
            cancellationPath: "available",
            canonicalStore: "available",
            internalLoop: "progressing",
            nodeSchedulability: Object.freeze({
              "synthetic-node-1": "schedulable",
            }),
            observationPath: "available",
            outboxPublisher: "progressing",
          }),
        telemetry,
      }),
      workloads: createPublicWorkloadController(operations.workloads),
    });
  }

  restart();
  return {
    database,
    get service() {
      return service;
    },
    restart,
    transport,
  };
}
