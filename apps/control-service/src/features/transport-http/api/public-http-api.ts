import type {
  ApiPermission,
  AuthorizedRequestContext,
} from "@workload-funnel/control-service/authorization";
import { AuthorizationDeniedError } from "@workload-funnel/control-service/authorization";
import { TransportAuthenticationError } from "@workload-funnel/control-service/authentication";
import type {
  ErasureOperationRequestV1,
  RetentionOperationRequestV1,
} from "@workload-funnel/control-service/result-controller";
import type {
  CancelWorkloadRequestV1,
  MutationEnvelopeV1,
  SubmitWorkloadRequestV1,
} from "@workload-funnel/control-service/workload-controller";
import {
  InvalidApiContractError,
  UnsupportedApiContractError,
  validateMutationEnvelope,
} from "@workload-funnel/control-service/workload-controller";

import {
  cursorFiltersDigest,
  ExpiredCursorError,
  InvalidCursorError,
} from "./signed-cursor.js";
import type {
  PublicHttpApi,
  PublicHttpApiDependencies,
  PublicHttpRequest,
  PublicHttpResponse,
} from "./public-http-contracts.js";

function response(status: number, body: unknown): PublicHttpResponse {
  return Object.freeze({
    body,
    headers: Object.freeze({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    }),
    status,
  });
}

function errorResponse(
  status: number,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): PublicHttpResponse {
  return response(
    status,
    Object.freeze({
      contractVersion: "workload-funnel.error/v1",
      error: Object.freeze({ code, ...details }),
    }),
  );
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidApiContractError("json_object_required");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1_048_576)
    throw new InvalidApiContractError("request_body_too_large");
  return value as Record<string, unknown>;
}

function queryText(
  request: PublicHttpRequest,
  key: string,
  required = true,
): string | undefined {
  const value = request.query?.[key];
  if (required && (value === undefined || value.length === 0))
    throw new InvalidApiContractError(`missing_${key}`);
  if (
    value !== undefined &&
    (value.length > (key === "cursor" ? 8192 : 512) || /\p{Cc}/u.test(value))
  )
    throw new InvalidApiContractError(`invalid_${key}`);
  return value;
}

function integerQuery(
  request: PublicHttpRequest,
  key: string,
  fallback?: number,
): number {
  const value = request.query?.[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (value === undefined || !/^\d{1,16}$/u.test(value))
    throw new InvalidApiContractError(`invalid_${key}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new InvalidApiContractError(`invalid_${key}`);
  return parsed;
}

function mutationFrom(body: Record<string, unknown>): MutationEnvelopeV1 {
  return body["mutation"] as MutationEnvelopeV1;
}

function tenantForMutation(body: Record<string, unknown>): string {
  const mutation = bodyObject(body["mutation"]);
  const tenant = mutation["requestedTenantScope"];
  if (typeof tenant !== "string" || tenant.length === 0)
    throw new InvalidApiContractError("missing_requested_tenant_scope");
  return tenant;
}

function pathSegments(path: string): readonly string[] {
  if (!path.startsWith("/") || path.length > 2048)
    throw new InvalidApiContractError("invalid_path");
  try {
    return Object.freeze(
      path
        .split("/")
        .filter(Boolean)
        .map((part) => decodeURIComponent(part)),
    );
  } catch {
    throw new InvalidApiContractError("invalid_path_encoding");
  }
}

function streamClass(
  value: string | undefined,
): "observation" | "cancellation" | "general" | undefined {
  if (value === undefined) return undefined;
  if (!["observation", "cancellation", "general"].includes(value))
    throw new InvalidApiContractError("invalid_stream_class");
  return value as "observation" | "cancellation" | "general";
}

function mutationCorrelation(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const mutation = (body as Record<string, unknown>)["mutation"];
  if (typeof mutation !== "object" || mutation === null) return undefined;
  const value = (mutation as Record<string, unknown>)["correlationId"];
  return typeof value === "string" ? value : undefined;
}

function stableRoute(path: string): string {
  const normalized = path
    .replace(
      /^\/v1\/workloads\/[^/]+\/cancellation$/u,
      "/v1/workloads/:runId/cancellation",
    )
    .replace(
      /^\/v1\/workloads\/[^/]+\/explanation$/u,
      "/v1/workloads/:runId/explanation",
    )
    .replace(/^\/v1\/workloads\/[^/]+$/u, "/v1/workloads/:runId")
    .replace(/^\/v1\/operations\/[^/]+$/u, "/v1/operations/:operationId")
    .replace(
      /^\/v1\/results\/[^/]+\/retention$/u,
      "/v1/results/:resultManifestId/retention",
    )
    .replace(/^\/v1\/results\/[^/]+$/u, "/v1/results/:resultManifestId")
    .replace(
      /^\/v1\/event-consumers\/[^/]+\/acknowledgements$/u,
      "/v1/event-consumers/:consumerId/acknowledgements",
    )
    .replace(
      /^\/v1\/event-consumers\/[^/]+$/u,
      "/v1/event-consumers/:consumerId",
    );
  return new Set([
    "/health",
    "/health/live",
    "/health/ready",
    "/metrics",
    "/v1/audit",
    "/v1/capacity",
    "/v1/erasures",
    "/v1/event-consumers",
    "/v1/event-consumers/:consumerId",
    "/v1/event-consumers/:consumerId/acknowledgements",
    "/v1/events",
    "/v1/operations/:operationId",
    "/v1/reconciliation-items",
    "/v1/results/:resultManifestId",
    "/v1/results/:resultManifestId/retention",
    "/v1/snapshots/workloads",
    "/v1/workloads",
    "/v1/workloads/:runId",
    "/v1/workloads/:runId/cancellation",
    "/v1/workloads/:runId/explanation",
  ]).has(normalized)
    ? normalized
    : "/unmatched";
}

class AdmissionUnavailableError extends Error {
  public readonly code = "admission_unavailable";

  public constructor() {
    super("admission_unavailable");
    this.name = "AdmissionUnavailableError";
  }
}

export function createPublicHttpApi(
  dependencies: PublicHttpApiDependencies,
): PublicHttpApi {
  function authorize(
    request: PublicHttpRequest,
    permission: ApiPermission,
    tenant: string,
    workload?: Readonly<{
      profile?: string;
      cpuMillis?: number;
      memoryMiB?: number;
    }>,
  ): AuthorizedRequestContext {
    if (request.credential === undefined)
      throw new TransportAuthenticationError();
    const identity = dependencies.authenticator.authenticate(
      request.credential,
      dependencies.clock(),
    );
    return dependencies.authorization.authorize(identity, {
      permission,
      requestedTenantScope: tenant,
      ...(workload?.profile === undefined
        ? {}
        : { workloadProfile: workload.profile }),
      ...(workload?.cpuMillis === undefined
        ? {}
        : { cpuMillis: workload.cpuMillis }),
      ...(workload?.memoryMiB === undefined
        ? {}
        : { memoryMiB: workload.memoryMiB }),
    });
  }

  function authenticatedRoute(
    request: PublicHttpRequest,
    segments: readonly string[],
    now: number,
  ): Readonly<{
    response: PublicHttpResponse;
    context: AuthorizedRequestContext;
  }> {
    if (request.method === "POST" && segments.join("/") === "v1/workloads") {
      const body = bodyObject(request.body);
      const tenant = tenantForMutation(body);
      const spec = bodyObject(body["spec"]);
      const resources = bodyObject(spec["resources"]);
      const context = authorize(request, "workload.submit", tenant, {
        ...(typeof resources["cpuMillis"] === "number"
          ? { cpuMillis: resources["cpuMillis"] }
          : {}),
        ...(typeof resources["memoryMiB"] === "number"
          ? { memoryMiB: resources["memoryMiB"] }
          : {}),
        ...(typeof spec["processProfile"] === "string"
          ? { profile: spec["processProfile"] }
          : {}),
      });
      if (dependencies.serviceOperations.health().serviceMode !== "full")
        throw new AdmissionUnavailableError();
      return Object.freeze({
        context,
        response: response(
          202,
          dependencies.workloads.submit(
            context,
            body as unknown as SubmitWorkloadRequestV1,
          ),
        ),
      });
    }

    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "workloads" &&
      segments[3] === "cancellation"
    ) {
      const body = bodyObject(request.body);
      const context = authorize(
        request,
        "workload.cancel",
        tenantForMutation(body),
      );
      return Object.freeze({
        context,
        response: response(
          202,
          dependencies.workloads.cancel(
            context,
            segments[2] ?? "",
            body as unknown as CancelWorkloadRequestV1,
          ),
        ),
      });
    }

    const tenant = queryText(request, "tenant", false) ?? "";
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "workloads"
    ) {
      const context = authorize(request, "workload.observe", tenant);
      const body = dependencies.workloads.observe(context, segments[2] ?? "");
      return Object.freeze({
        context,
        response:
          body === undefined
            ? errorResponse(404, "not_found")
            : response(200, body),
      });
    }
    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "workloads" &&
      segments[3] === "explanation"
    ) {
      const context = authorize(request, "explanation.observe", tenant);
      const body = dependencies.workloads.explanation(
        context,
        segments[2] ?? "",
      );
      return Object.freeze({
        context,
        response:
          body === undefined
            ? errorResponse(404, "not_found")
            : response(200, body),
      });
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "operations"
    ) {
      const context = authorize(request, "operation.observe", tenant);
      const body = dependencies.workloads.operation(context, segments[2] ?? "");
      return Object.freeze({
        context,
        response:
          body === undefined
            ? errorResponse(404, "not_found")
            : response(200, body),
      });
    }
    if (request.method === "GET" && segments.join("/") === "v1/capacity") {
      const context = authorize(request, "capacity.observe", tenant);
      return Object.freeze({
        context,
        response: response(200, dependencies.capacity.observe(context)),
      });
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "results"
    ) {
      const context = authorize(request, "result.observe", tenant);
      const body = dependencies.results.result(context, segments[2] ?? "");
      return Object.freeze({
        context,
        response:
          body === undefined
            ? errorResponse(404, "not_found")
            : response(200, body),
      });
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "results" &&
      segments[3] === "retention"
    ) {
      const body = bodyObject(request.body);
      const context = authorize(
        request,
        "retention.manage",
        tenantForMutation(body),
      );
      return Object.freeze({
        context,
        response: response(
          202,
          dependencies.results.requestRetention(
            context,
            segments[2] ?? "",
            body as unknown as RetentionOperationRequestV1,
          ),
        ),
      });
    }
    if (request.method === "POST" && segments.join("/") === "v1/erasures") {
      const body = bodyObject(request.body);
      const context = authorize(
        request,
        "erasure.manage",
        tenantForMutation(body),
      );
      return Object.freeze({
        context,
        response: response(
          202,
          dependencies.results.requestErasure(
            context,
            body as unknown as ErasureOperationRequestV1,
          ),
        ),
      });
    }
    if (request.method === "GET" && segments.join("/") === "v1/audit") {
      const context = authorize(request, "audit.observe", tenant);
      return Object.freeze({
        context,
        response: response(200, {
          contractVersion: "workload-funnel.audit-page/v1",
          records: dependencies.results.audit(
            context,
            integerQuery(request, "after", 0),
            integerQuery(request, "limit", 100),
          ),
        }),
      });
    }
    if (
      request.method === "GET" &&
      segments.join("/") === "v1/reconciliation-items"
    ) {
      const context = authorize(request, "reconciliation.observe", tenant);
      return Object.freeze({
        context,
        response: response(
          200,
          dependencies.reconciliation.list(
            context,
            queryText(request, "after", false),
            integerQuery(request, "limit", 100),
          ),
        ),
      });
    }
    if (
      request.method === "GET" &&
      segments.join("/") === "v1/snapshots/workloads"
    ) {
      const context = authorize(request, "events.observe", tenant);
      const partition = queryText(request, "partition", false) ?? "control-1";
      const snapshot = dependencies.events.snapshot(context, partition, now);
      const filtersDigest = cursorFiltersDigest({
        streamClass: request.query?.["streamClass"],
      });
      const cursor = dependencies.cursorCodec.encode(
        {
          filtersDigest,
          partition,
          schemaVersion: 1,
          snapshotWatermark: snapshot.snapshotWatermark,
          tenantId: context.effectiveTenantId,
        },
        { eventId: "", streamPosition: snapshot.snapshotWatermark },
        now,
      );
      return Object.freeze({
        context,
        response: response(200, { ...snapshot, cursor }),
      });
    }
    if (request.method === "GET" && segments.join("/") === "v1/events") {
      const context = authorize(request, "events.observe", tenant);
      const cursor = queryText(request, "cursor") ?? "";
      const partition = queryText(request, "partition", false) ?? "control-1";
      const snapshotWatermark = integerQuery(request, "snapshotWatermark");
      const selectedClass = streamClass(request.query?.["streamClass"]);
      const filtersDigest = cursorFiltersDigest({ streamClass: selectedClass });
      const decoded = dependencies.cursorCodec.decode(
        cursor,
        {
          filtersDigest,
          partition,
          schemaVersion: 1,
          snapshotWatermark,
          tenantId: context.effectiveTenantId,
        },
        now,
      );
      const page = dependencies.events.page(context, {
        after: decoded,
        limit: integerQuery(request, "limit", 100),
        partition,
        snapshotWatermark,
        ...(selectedClass === undefined ? {} : { streamClass: selectedClass }),
      });
      const nextCursor = dependencies.cursorCodec.encode(
        {
          filtersDigest,
          partition,
          schemaVersion: 1,
          snapshotWatermark,
          tenantId: context.effectiveTenantId,
        },
        page.after,
        now,
      );
      return Object.freeze({
        context,
        response: response(200, {
          contractVersion: "workload-funnel.event-page/v1",
          ...page,
          cursor: nextCursor,
          snapshotWatermark,
        }),
      });
    }
    if (
      request.method === "POST" &&
      segments.join("/") === "v1/event-consumers"
    ) {
      const body = bodyObject(request.body);
      const context = authorize(
        request,
        "consumer.manage",
        tenantForMutation(body),
      );
      const mutation = validateMutationEnvelope(mutationFrom(body), context);
      const cursor = body["cursor"];
      const partition =
        typeof body["partition"] === "string" ? body["partition"] : "control-1";
      const snapshotWatermark = body["snapshotWatermark"];
      if (typeof cursor !== "string" || typeof snapshotWatermark !== "number")
        throw new InvalidApiContractError("invalid_consumer_cursor");
      const selectedClass = streamClass(
        typeof body["streamClass"] === "string"
          ? body["streamClass"]
          : undefined,
      );
      const filtersDigest = cursorFiltersDigest({ streamClass: selectedClass });
      const decoded = dependencies.cursorCodec.decode(
        cursor,
        {
          filtersDigest,
          partition,
          schemaVersion: 1,
          snapshotWatermark,
          tenantId: context.effectiveTenantId,
        },
        now,
      );
      return Object.freeze({
        context,
        response: response(
          201,
          dependencies.events.registerConsumer(
            context,
            mutation,
            body,
            decoded,
            now,
          ),
        ),
      });
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "event-consumers" &&
      segments[3] === "acknowledgements"
    ) {
      const body = bodyObject(request.body);
      const context = authorize(
        request,
        "consumer.manage",
        tenantForMutation(body),
      );
      const mutation = validateMutationEnvelope(mutationFrom(body), context);
      const through = bodyObject(body["through"]);
      if (
        !Number.isSafeInteger(through["streamPosition"]) ||
        (through["streamPosition"] as number) < 0 ||
        typeof through["eventId"] !== "string"
      )
        throw new InvalidApiContractError("invalid_consumer_acknowledgement");
      return Object.freeze({
        context,
        response: response(
          200,
          dependencies.events.acknowledge(
            context,
            mutation,
            segments[2] ?? "",
            through as unknown as Readonly<{
              streamPosition: number;
              eventId: string;
            }>,
            now,
          ),
        ),
      });
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "v1" &&
      segments[1] === "event-consumers"
    ) {
      const context = authorize(request, "consumer.manage", tenant);
      return Object.freeze({
        context,
        response: response(
          200,
          dependencies.events.consume(context, segments[2] ?? "", now),
        ),
      });
    }
    if (request.method === "GET" && segments.join("/") === "metrics") {
      const context = authorize(request, "metrics.observe", tenant);
      return Object.freeze({
        context,
        response: response(
          200,
          dependencies.serviceOperations.metrics(context),
        ),
      });
    }
    throw new InvalidApiContractError("route_not_found");
  }

  const api: PublicHttpApi = {
    handle(request) {
      const startedAt = dependencies.clock();
      let context: AuthorizedRequestContext | undefined;
      let result: PublicHttpResponse;
      try {
        const segments = pathSegments(request.path);
        if (request.method === "GET" && segments.join("/") === "health/live") {
          const health = dependencies.serviceOperations.health();
          result = response(health.liveness === "live" ? 200 : 503, health);
        } else if (
          request.method === "GET" &&
          segments.join("/") === "health/ready"
        ) {
          const health = dependencies.serviceOperations.health();
          result = response(health.readiness === "ready" ? 200 : 503, health);
        } else if (
          request.method === "GET" &&
          segments.join("/") === "health"
        ) {
          const health = dependencies.serviceOperations.health();
          result = response(
            health.serviceMode === "full"
              ? 200
              : health.serviceMode === "degraded_observe_cancel_only"
                ? 207
                : 503,
            health,
          );
        } else {
          const routed = authenticatedRoute(request, segments, startedAt);
          context = routed.context;
          result = routed.response;
        }
      } catch (error) {
        if (error instanceof TransportAuthenticationError)
          result = errorResponse(401, error.code);
        else if (error instanceof AuthorizationDeniedError)
          result = errorResponse(403, error.code, { reason: error.reason });
        else if (error instanceof AdmissionUnavailableError)
          result = errorResponse(503, error.code);
        else if (error instanceof ExpiredCursorError)
          result = errorResponse(410, error.code, {
            snapshotPath: error.snapshotPath,
          });
        else if (error instanceof InvalidCursorError)
          result = errorResponse(400, error.code);
        else if (error instanceof UnsupportedApiContractError)
          result = errorResponse(422, error.code);
        else if (error instanceof InvalidApiContractError)
          result =
            error.message === "route_not_found"
              ? errorResponse(404, "not_found")
              : errorResponse(400, error.code);
        else {
          const bootstrapError = error as Readonly<{
            code?: unknown;
            registration?: unknown;
            snapshotPath?: unknown;
            oldestAvailablePosition?: unknown;
          }>;
          if (
            error instanceof Error &&
            error.name === "ClosedOperationGateError"
          ) {
            result = errorResponse(409, "operation_gate_closed");
          } else if (
            bootstrapError.code === "consumer_bootstrap_required" &&
            typeof bootstrapError.snapshotPath === "string"
          ) {
            result = errorResponse(410, "consumer_bootstrap_required", {
              registration: bootstrapError.registration,
              snapshotPath: bootstrapError.snapshotPath,
            });
          } else if (
            bootstrapError.code === "cursor_expired" &&
            typeof bootstrapError.snapshotPath === "string"
          ) {
            result = errorResponse(410, "cursor_expired", {
              oldestAvailablePosition: bootstrapError.oldestAvailablePosition,
              snapshotPath: bootstrapError.snapshotPath,
            });
          } else {
            const code =
              error instanceof Error &&
              error.message ===
                "Idempotency key is already bound to a different WorkloadSpec"
                ? "idempotency_key_conflict"
                : error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)
                  ? error.message
                  : "internal_error";
            result = errorResponse(
              code === "internal_error"
                ? 500
                : code === "not_found"
                  ? 404
                  : code.startsWith("unsupported_")
                    ? 422
                    : code.includes("conflict")
                      ? 409
                      : 400,
              code,
            );
          }
        }
      }
      const correlationId = mutationCorrelation(request.body);
      dependencies.serviceOperations.recordHttp({
        durationMs: Math.max(0, dependencies.clock() - startedAt),
        method: request.method,
        route: stableRoute(request.path),
        status: result.status,
        ...(correlationId === undefined ? {} : { correlationId }),
        ...(context === undefined
          ? {}
          : {
              effectiveTenantId: context.effectiveTenantId,
              principalId: context.principalId,
            }),
      });
      return result;
    },
  };
  return Object.freeze(api);
}
