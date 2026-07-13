import type {
  AcceptanceReceipt,
  WorkloadSpec,
} from "@workload-funnel/workload-control/workload-lifecycle";

export interface SdkHttpRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface SdkHttpTransport {
  request<T>(request: SdkHttpRequest): Promise<T>;
}

export interface MutationOptions {
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly requestId?: string;
  readonly expectedVersion?: number;
}

export interface WorkloadSubmissionClient {
  submit(
    spec: WorkloadSpec,
    options: MutationOptions,
  ): Promise<AcceptanceReceipt>;
}

export class WorkloadFunnelApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: unknown,
  ) {
    super(code);
    this.name = "WorkloadFunnelApiError";
  }
}

export function mutationEnvelope(
  tenantId: string,
  options: MutationOptions,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    causationId: options.causationId ?? options.correlationId,
    contractVersion: "workload-funnel.mutation/v1",
    correlationId: options.correlationId,
    expectedVersion: options.expectedVersion,
    idempotencyKey: options.idempotencyKey,
    requestedTenantScope: tenantId,
    requestId: options.requestId ?? crypto.randomUUID(),
  });
}

export function createWorkloadSubmissionClient(
  transport: SdkHttpTransport,
  tenantId: string,
): WorkloadSubmissionClient {
  const client: WorkloadSubmissionClient = {
    async submit(spec, options) {
      const response = await transport.request<{
        contractVersion: string;
        operation: AcceptanceReceipt;
      }>({
        body: Object.freeze({
          contractVersion: "workload-funnel.api/v1",
          mutation: mutationEnvelope(tenantId, options),
          spec,
        }),
        method: "POST",
        path: "/v1/workloads",
      });
      if (response.contractVersion !== "workload-funnel.api/v1")
        throw new WorkloadFunnelApiError(
          502,
          "invalid_server_contract",
          response,
        );
      return response.operation;
    },
  };
  return Object.freeze(client);
}

export function createFetchSdkTransport(
  input: Readonly<{
    baseUrl: string;
    bearerToken: () => string | Promise<string>;
    maximumResponseBytes?: number;
    fetchImplementation?: typeof fetch;
  }>,
): SdkHttpTransport {
  const baseUrl = new URL(input.baseUrl);
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username.length > 0 ||
    baseUrl.password.length > 0 ||
    baseUrl.search.length > 0 ||
    baseUrl.hash.length > 0
  )
    throw new Error("invalid_api_base_url");
  const maximumResponseBytes = input.maximumResponseBytes ?? 2_097_152;
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > 67_108_864
  )
    throw new Error("invalid_maximum_response_bytes");
  const fetchImplementation = input.fetchImplementation ?? fetch;

  async function boundedResponseText(result: Response): Promise<string> {
    if (result.body === null) return "";
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = result.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > maximumResponseBytes) {
          await reader.cancel();
          throw new WorkloadFunnelApiError(
            502,
            "response_too_large",
            undefined,
          );
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  return Object.freeze({
    async request<T>(request: SdkHttpRequest): Promise<T> {
      if (!request.path.startsWith("/") || request.path.startsWith("//"))
        throw new Error("invalid_api_path");
      const url = new URL(request.path, baseUrl);
      if (url.origin !== baseUrl.origin)
        throw new Error("invalid_api_path_origin");
      for (const [key, value] of Object.entries(request.query ?? {}))
        url.searchParams.set(key, value);
      if (url.toString().length > 16_384) throw new Error("api_url_too_large");
      const token = await input.bearerToken();
      if (
        typeof token !== "string" ||
        token.length < 1 ||
        token.length > 16_384 ||
        /[\r\n]/u.test(token)
      )
        throw new Error("invalid_bearer_token");
      const encodedBody =
        request.body === undefined ? undefined : JSON.stringify(request.body);
      if (request.body !== undefined && encodedBody === undefined)
        throw new Error("invalid_request_body");
      if (
        encodedBody !== undefined &&
        new TextEncoder().encode(encodedBody).byteLength > 1_048_576
      )
        throw new Error("request_body_too_large");
      const result = await fetchImplementation(url, {
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...(encodedBody === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        method: request.method,
        redirect: "error",
      });
      const contentLength = Number(result.headers.get("content-length") ?? 0);
      if (contentLength > maximumResponseBytes)
        throw new WorkloadFunnelApiError(502, "response_too_large", undefined);
      const text = await boundedResponseText(result);
      let decoded: unknown;
      try {
        decoded = JSON.parse(text);
      } catch {
        throw new WorkloadFunnelApiError(
          502,
          "invalid_json_response",
          undefined,
        );
      }
      if (!result.ok) {
        const error = (decoded as { error?: { code?: unknown } }).error;
        throw new WorkloadFunnelApiError(
          result.status,
          typeof error?.code === "string" ? error.code : "api_error",
          decoded,
        );
      }
      return decoded as T;
    },
  });
}
