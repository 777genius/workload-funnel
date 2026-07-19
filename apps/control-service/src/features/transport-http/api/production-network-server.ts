import { createServer, type Server, type ServerOptions } from "node:https";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";
import { TLSSocket } from "node:tls";

import {
  createTransportAuthenticator,
  TransportAuthenticationError,
} from "@workload-funnel/control-service/authentication";
import {
  AuthorizationDeniedError,
  createAuthorizationService,
  type ApiPermission,
} from "@workload-funnel/control-service/authorization";
import {
  InvalidApiContractError,
  UnsupportedApiContractError,
  validateMutationEnvelope,
  type MutationEnvelopeV1,
} from "@workload-funnel/control-service/workload-controller";

import type { ProductionServerConfig } from "./production-server-config.js";

export interface ProductionRequestPrincipal {
  readonly namespaceId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export type ProductionResponseValue = object | string | number | boolean | null;

export interface ProductionHttpOperations {
  cancel(
    principal: ProductionRequestPrincipal,
    runId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<ProductionResponseValue>;
  operation(
    principal: ProductionRequestPrincipal,
    operationId: string,
    signal: AbortSignal,
  ): Promise<ProductionResponseValue | undefined>;
  status(
    principal: ProductionRequestPrincipal,
    runId: string,
    signal: AbortSignal,
  ): Promise<ProductionResponseValue | undefined>;
  submit(
    principal: ProductionRequestPrincipal,
    idempotencyKey: string,
    spec: unknown,
    signal: AbortSignal,
  ): Promise<ProductionResponseValue>;
}

export interface ProductionNetworkService {
  close(): Promise<void>;
  listen(): Promise<Readonly<{ host: string; port: number }>>;
  liveness(): "live" | "failed";
  readiness(): Promise<"ready" | "not_ready">;
}

interface ErrorWithCode {
  readonly code?: unknown;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(payload.byteLength),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function failure(response: ServerResponse, status: number, code: string): void {
  json(response, status, {
    contractVersion: "workload-funnel.error/v1",
    error: { code },
  });
}

function boundedText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 512 ||
    /\p{Cc}/u.test(value)
  )
    throw new InvalidApiContractError(`invalid_${name}`);
  return value;
}

function bodyObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new InvalidApiContractError("json_object_required");
  return value as Record<string, unknown>;
}

function requestPath(request: IncomingMessage): URL {
  const host = request.headers.host;
  if (host === undefined || host.length > 512)
    throw new InvalidApiContractError("invalid_host");
  try {
    return new URL(request.url ?? "", `https://${host}`);
  } catch {
    throw new InvalidApiContractError("invalid_path");
  }
}

async function readBody(
  request: IncomingMessage,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (signal.aborted) throw new Error("request_aborted");
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
      throw new InvalidApiContractError("invalid_request_body");
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maximumBytes)
      throw new InvalidApiContractError("request_body_too_large");
    chunks.push(buffer);
  }
  if (!request.complete) throw new Error("request_aborted");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidApiContractError("invalid_json");
  }
}

function publicError(
  error: unknown,
): Readonly<{ code: string; status: number }> {
  if (error instanceof TransportAuthenticationError)
    return { code: "unauthenticated", status: 401 };
  if (error instanceof AuthorizationDeniedError)
    return { code: "permission_denied", status: 403 };
  if (error instanceof InvalidApiContractError)
    return { code: "invalid_contract", status: 400 };
  if (error instanceof Error && error.name === "InvalidWorkloadError")
    return { code: "invalid_contract", status: 400 };
  if (error instanceof UnsupportedApiContractError)
    return { code: "unsupported_contract", status: 400 };
  const code =
    typeof (error as ErrorWithCode | null)?.code === "string"
      ? (error as { code: string }).code
      : "internal_error";
  if (code.endsWith("_not_found")) return { code: "not_found", status: 404 };
  if (code.includes("conflict") || code.includes("idempotency"))
    return { code: "conflict", status: 409 };
  if (code.includes("aborted")) return { code: "request_aborted", status: 499 };
  if (
    code.includes("unavailable") ||
    code.includes("timeout") ||
    code.includes("closed") ||
    code.includes("unknown")
  )
    return { code: "temporarily_unavailable", status: 503 };
  return { code: "internal_error", status: 500 };
}

export function createProductionNetworkService(
  input: Readonly<{
    config: ProductionServerConfig;
    dependencyHealth: (signal?: AbortSignal) => Promise<boolean>;
    operations: ProductionHttpOperations;
    serverFactory?: (
      options: ServerOptions,
      listener: RequestListener,
    ) => Server;
  }>,
): ProductionNetworkService {
  const { config } = input;
  const authenticator = createTransportAuthenticator(config.identityBindings);
  const authorization = createAuthorizationService(
    config.authorizationPolicies,
  );
  const active = new Set<AbortController>();
  let listening = false;
  let draining = false;
  let failed = false;
  let closePromise: Promise<void> | undefined;
  let listenPromise:
    | Promise<Readonly<{ host: string; port: number }>>
    | undefined;

  function authenticate(
    request: IncomingMessage,
    permission: ApiPermission,
    tenantId: string,
    workload?: Readonly<{
      cpuMillis?: number;
      memoryMiB?: number;
      profile?: string;
    }>,
  ) {
    if (!(request.socket instanceof TLSSocket) || !request.socket.authorized)
      throw new TransportAuthenticationError();
    const certificate = request.socket.getPeerCertificate();
    if (certificate.fingerprint256.length === 0)
      throw new TransportAuthenticationError();
    const identity = authenticator.authenticate(
      {
        kind: "verified-mtls",
        certificateFingerprint: certificate.fingerprint256,
      },
      Date.now(),
    );
    return authorization.authorize(identity, {
      permission,
      requestedTenantScope: tenantId,
      ...(workload?.cpuMillis === undefined
        ? {}
        : { cpuMillis: workload.cpuMillis }),
      ...(workload?.memoryMiB === undefined
        ? {}
        : { memoryMiB: workload.memoryMiB }),
      ...(workload?.profile === undefined
        ? {}
        : { workloadProfile: workload.profile }),
    });
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const url = requestPath(request);
    let segments: string[];
    try {
      segments = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
    } catch {
      throw new InvalidApiContractError("invalid_path_encoding");
    }
    if (request.method === "GET" && url.pathname === "/health/live") {
      json(response, failed ? 500 : 200, {
        contractVersion: "workload-funnel.health/v1",
        liveness: failed ? "failed" : "live",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      const ready =
        !draining &&
        !failed &&
        listening &&
        (await input.dependencyHealth(signal));
      json(response, ready ? 200 : 503, {
        contractVersion: "workload-funnel.health/v1",
        readiness: ready ? "ready" : "not_ready",
      });
      return;
    }
    if (draining) {
      failure(response, 503, "service_draining");
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workloads") {
      const body = bodyObject(
        await readBody(request, config.network.maxRequestBytes, signal),
      );
      if (body["contractVersion"] !== "workload-funnel.api/v1")
        throw new UnsupportedApiContractError("unsupported_api_contract");
      const mutation = bodyObject(
        body["mutation"],
      ) as unknown as MutationEnvelopeV1;
      const spec = bodyObject(body["spec"]);
      const resources = bodyObject(spec["resources"]);
      const requestedTenant = boundedText(
        mutation.requestedTenantScope,
        "requested_tenant_scope",
      );
      const context = authenticate(
        request,
        "workload.submit",
        requestedTenant,
        {
          ...(typeof resources["cpuMillis"] === "number"
            ? { cpuMillis: resources["cpuMillis"] }
            : {}),
          ...(typeof resources["memoryMiB"] === "number"
            ? { memoryMiB: resources["memoryMiB"] }
            : {}),
          ...(typeof spec["processProfile"] === "string"
            ? { profile: spec["processProfile"] }
            : {}),
        },
      );
      const operation = validateMutationEnvelope(mutation, context);
      json(response, 202, {
        contractVersion: "workload-funnel.api/v1",
        operation: await input.operations.submit(
          {
            namespaceId: config.namespaceId,
            principalId: context.principalId,
            tenantId: context.effectiveTenantId,
          },
          operation.idempotencyKey,
          spec,
          signal,
        ),
      });
      return;
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[0] === "v1" &&
      segments[1] === "workloads" &&
      segments[3] === "cancellation"
    ) {
      const body = bodyObject(
        await readBody(request, config.network.maxRequestBytes, signal),
      );
      if (body["contractVersion"] !== "workload-funnel.api/v1")
        throw new UnsupportedApiContractError("unsupported_api_contract");
      boundedText(body["reason"], "cancellation_reason");
      const mutation = bodyObject(
        body["mutation"],
      ) as unknown as MutationEnvelopeV1;
      const requestedTenant = boundedText(
        mutation.requestedTenantScope,
        "requested_tenant_scope",
      );
      const context = authenticate(request, "workload.cancel", requestedTenant);
      const operation = validateMutationEnvelope(mutation, context);
      json(response, 202, {
        contractVersion: "workload-funnel.api/v1",
        operation: await input.operations.cancel(
          {
            namespaceId: config.namespaceId,
            principalId: context.principalId,
            tenantId: context.effectiveTenantId,
          },
          boundedText(segments[2], "run_id"),
          operation.idempotencyKey,
          signal,
        ),
      });
      return;
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[0] === "v1" &&
      (segments[1] === "workloads" || segments[1] === "operations")
    ) {
      const tenantId = boundedText(url.searchParams.get("tenant"), "tenant");
      const permission =
        segments[1] === "workloads" ? "workload.observe" : "operation.observe";
      const context = authenticate(request, permission, tenantId);
      const principal = {
        namespaceId: config.namespaceId,
        principalId: context.principalId,
        tenantId: context.effectiveTenantId,
      };
      const value =
        segments[1] === "workloads"
          ? await input.operations.status(
              principal,
              boundedText(segments[2], "run_id"),
              signal,
            )
          : await input.operations.operation(
              principal,
              boundedText(segments[2], "operation_id"),
              signal,
            );
      if (value === undefined) failure(response, 404, "not_found");
      else json(response, 200, value);
      return;
    }
    failure(response, 404, "not_found");
  }

  const server: Server = (input.serverFactory ?? createServer)(
    {
      ca: config.network.tls.certificateAuthority,
      cert: config.network.tls.certificate,
      key: config.network.tls.privateKey,
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
      requestCert: true,
    },
    (request, response) => {
      const controller = new AbortController();
      active.add(controller);
      const abort = () => {
        controller.abort();
      };
      request.once("aborted", abort);
      request.setTimeout(config.network.requestTimeoutMs, abort);
      void route(request, response, controller.signal)
        .catch((error: unknown) => {
          const rendered = publicError(error);
          failure(response, rendered.status, rendered.code);
        })
        .finally(() => {
          active.delete(controller);
          request.off("aborted", abort);
        });
    },
  );
  server.headersTimeout = config.network.headersTimeoutMs;
  server.keepAliveTimeout = config.network.keepAliveTimeoutMs;
  server.maxConnections = config.network.maxConnections;
  server.requestTimeout = config.network.requestTimeoutMs;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("tlsClientError", () => undefined);
  server.on("error", () => {
    if (listening) failed = true;
  });
  server.on("close", () => {
    listening = false;
    if (!draining) failed = true;
  });

  return Object.freeze({
    liveness: () => (failed ? "failed" : "live"),
    readiness: async () =>
      !draining && !failed && listening && (await input.dependencyHealth())
        ? "ready"
        : "not_ready",
    listen: () => {
      if (draining || failed)
        return Promise.reject(new Error("production_server_unavailable"));
      if (listening)
        return Promise.resolve({
          host: config.network.host,
          port: config.network.port,
        });
      if (listenPromise !== undefined) return listenPromise;
      listenPromise = new Promise<Readonly<{ host: string; port: number }>>(
        (resolve, reject) => {
          const onError = (error: Error) => {
            server.off("listening", onListening);
            failed = true;
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            listening = true;
            resolve(
              Object.freeze({
                host: config.network.host,
                port: config.network.port,
              }),
            );
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(config.network.port, config.network.host);
        },
      );
      return listenPromise;
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      draining = true;
      closePromise = (async () => {
        if (!listening) await listenPromise?.catch(() => undefined);
        if (!listening) return;
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            listening = false;
            resolve();
          };
          const timer = setTimeout(() => {
            for (const controller of active) controller.abort();
            server.closeAllConnections();
            finish();
          }, config.network.drainTimeoutMs);
          timer.unref();
          server.close(() => {
            clearTimeout(timer);
            finish();
          });
          server.closeIdleConnections();
        });
      })();
      return closePromise;
    },
  });
}

export function installProductionSignalHandlers(
  service: Pick<ProductionNetworkService, "close">,
  signalTarget: Pick<NodeJS.Process, "once" | "off"> = process,
): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().catch(() => {
      process.exitCode = 1;
    });
  };
  signalTarget.once("SIGINT", stop);
  signalTarget.once("SIGTERM", stop);
  return () => {
    signalTarget.off("SIGINT", stop);
    signalTarget.off("SIGTERM", stop);
  };
}
