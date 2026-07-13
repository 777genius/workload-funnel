import type { ServiceHealthV1 } from "./health-semantics.js";
import type {
  TelemetryDomainSnapshot,
  TelemetryProvider,
} from "./telemetry-provider.js";

export interface ServiceOperationsAdapter {
  health(): ServiceHealthV1;
  metrics(
    context: Readonly<{ principalId: string; effectiveTenantId: string }>,
  ): unknown;
  recordHttp(
    input: Readonly<{
      method: string;
      route: string;
      status: number;
      durationMs: number;
      principalId?: string;
      effectiveTenantId?: string;
      correlationId?: string;
    }>,
  ): void;
}

export function createServiceOperationsAdapter(
  input: Readonly<{
    telemetry: TelemetryProvider;
    health: () => ServiceHealthV1;
    clock: () => number;
    domainSnapshot?: () => TelemetryDomainSnapshot;
  }>,
): ServiceOperationsAdapter {
  let spanSequence = 0;
  const adapter: ServiceOperationsAdapter = {
    health: input.health,
    metrics() {
      return Object.freeze({
        contractVersion: "workload-funnel.metrics/v1",
        points: input.telemetry.snapshot().metrics,
      });
    },
    recordHttp(request) {
      try {
        const now = input.clock();
        input.telemetry.recordMetric(
          "http_requests",
          1,
          Object.freeze({
            method: request.method,
            route: request.route,
            status: String(request.status),
          }),
          now,
        );
        input.telemetry.log({
          fields: Object.freeze({
            durationMs: request.durationMs,
            ...(request.effectiveTenantId === undefined
              ? {}
              : { effectiveTenantId: request.effectiveTenantId }),
            method: request.method,
            ...(request.principalId === undefined
              ? {}
              : { principalId: request.principalId }),
            route: request.route,
            status: request.status,
          }),
          level: request.status >= 500 ? "error" : "info",
          message: "http_request_completed",
          occurredAt: now,
        });
        input.telemetry.recordMetric(
          "http_duration",
          request.durationMs,
          Object.freeze({ method: request.method, route: request.route }),
          now,
        );
        if (request.correlationId !== undefined) {
          spanSequence += 1;
          const spanId = `http-${String(spanSequence)}`;
          input.telemetry.startSpan({
            attributes: Object.freeze({
              method: request.method,
              route: request.route,
              status: request.status,
            }),
            correlationId: request.correlationId,
            spanId,
            stage: "request",
            startedAt: now - request.durationMs,
            traceId: request.correlationId,
          });
          input.telemetry.endSpan(
            spanId,
            now,
            request.status < 400 ? "ok" : "error",
          );
        }
        if (input.domainSnapshot !== undefined)
          input.telemetry.recordDomainSnapshot(input.domainSnapshot(), now);
      } catch {
        // Telemetry loss must not change API correctness.
      }
    },
  };
  return Object.freeze(adapter);
}
