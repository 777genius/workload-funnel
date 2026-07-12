import {
  parseSignedExecutionTicket,
  type SignedExecutionTicket,
  TicketValidationError,
} from "@workload-funnel/node-execution/execution-ticket-validation";

export const LAUNCHER_RPC_PROTOCOL = "phase4a.launcher-rpc.v1" as const;

export interface UnixPeerIdentity {
  readonly gid: number;
  readonly pid: number;
  readonly transport: "unix";
  readonly uid: number;
}

export interface LauncherRpcRequest {
  readonly method: "observe" | "start" | "stop";
  readonly protocolVersion: typeof LAUNCHER_RPC_PROTOCOL;
  readonly requestId: string;
  readonly ticket: SignedExecutionTicket;
}

export type LauncherErrorCode =
  | "authority_mismatch"
  | "malformed_request"
  | "peer_not_authorized"
  | "production_start_disabled"
  | "ticket_rejected"
  | "unsupported_host_capability";

export interface LauncherRpcSuccess {
  readonly ok: true;
  readonly protocolVersion: typeof LAUNCHER_RPC_PROTOCOL;
  readonly requestId: string;
  readonly result: {
    readonly state:
      | "active"
      | "failed"
      | "inactive"
      | "started"
      | "stopped"
      | "unknown";
    readonly unitName: string;
  };
}

export interface LauncherRpcFailure {
  readonly error: {
    readonly code: LauncherErrorCode;
    readonly message: string;
  };
  readonly ok: false;
  readonly protocolVersion: typeof LAUNCHER_RPC_PROTOCOL;
  readonly requestId: string;
}

export type LauncherRpcResponse = LauncherRpcFailure | LauncherRpcSuccess;

export interface UnixLauncherRpcTransport {
  exchange(payload: string): {
    readonly payload: string;
    readonly peer: UnixPeerIdentity;
  };
}

interface UntrustedRpcRecord {
  readonly [key: string]: unknown;
  readonly code?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly method?: unknown;
  readonly ok?: unknown;
  readonly protocolVersion?: unknown;
  readonly requestId?: unknown;
  readonly result?: unknown;
  readonly state?: unknown;
  readonly ticket?: unknown;
  readonly unitName?: unknown;
}

function asRecord(value: unknown, location: string): UntrustedRpcRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as UntrustedRpcRecord;
}

function assertExactKeys(
  value: UntrustedRpcRecord,
  keys: readonly string[],
  location: string,
): void {
  if (
    Object.keys(value).sort().join("\u0000") !== [...keys].sort().join("\u0000")
  ) {
    throw new Error(`${location} contains missing or unknown fields`);
  }
}

function requestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
  ) {
    throw new Error("requestId is invalid");
  }
  return value;
}

export function parseLauncherRpcRequest(payload: string): LauncherRpcRequest {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("launcher request is not valid JSON");
  }
  const value = asRecord(decoded, "request");
  assertExactKeys(
    value,
    ["method", "protocolVersion", "requestId", "ticket"],
    "request",
  );
  if (value.protocolVersion !== LAUNCHER_RPC_PROTOCOL) {
    throw new Error("launcher protocol version is unsupported");
  }
  if (
    value.method !== "start" &&
    value.method !== "observe" &&
    value.method !== "stop"
  ) {
    throw new Error("launcher method is not allowlisted");
  }
  try {
    return {
      method: value.method,
      protocolVersion: LAUNCHER_RPC_PROTOCOL,
      requestId: requestId(value.requestId),
      ticket: parseSignedExecutionTicket(value.ticket),
    };
  } catch (error) {
    if (error instanceof TicketValidationError) {
      throw new Error(`ticket schema rejected: ${error.code}`);
    }
    throw error;
  }
}

export function encodeLauncherRpcRequest(request: LauncherRpcRequest): string {
  return JSON.stringify(request);
}

export function parseLauncherRpcResponse(payload: string): LauncherRpcResponse {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload) as unknown;
  } catch {
    throw new Error("launcher response is not valid JSON");
  }
  const value = asRecord(decoded, "response");
  if (value.protocolVersion !== LAUNCHER_RPC_PROTOCOL) {
    throw new Error("launcher response protocol version is unsupported");
  }
  const id = requestId(value.requestId);
  if (value.ok === true) {
    assertExactKeys(
      value,
      ["ok", "protocolVersion", "requestId", "result"],
      "response",
    );
    const result = asRecord(value.result, "response.result");
    assertExactKeys(result, ["state", "unitName"], "response.result");
    const allowedStates = new Set([
      "active",
      "failed",
      "inactive",
      "started",
      "stopped",
      "unknown",
    ]);
    if (
      typeof result.state !== "string" ||
      !allowedStates.has(result.state) ||
      typeof result.unitName !== "string"
    ) {
      throw new Error("launcher response result is invalid");
    }
    return {
      ok: true,
      protocolVersion: LAUNCHER_RPC_PROTOCOL,
      requestId: id,
      result: {
        state: result.state as LauncherRpcSuccess["result"]["state"],
        unitName: result.unitName,
      },
    };
  }
  if (value.ok === false) {
    assertExactKeys(
      value,
      ["error", "ok", "protocolVersion", "requestId"],
      "response",
    );
    const error = asRecord(value.error, "response.error");
    assertExactKeys(error, ["code", "message"], "response.error");
    const allowedCodes: ReadonlySet<string> = new Set<LauncherErrorCode>([
      "authority_mismatch",
      "malformed_request",
      "peer_not_authorized",
      "production_start_disabled",
      "ticket_rejected",
      "unsupported_host_capability",
    ]);
    if (
      typeof error.code !== "string" ||
      !allowedCodes.has(error.code) ||
      typeof error.message !== "string"
    ) {
      throw new Error("launcher response error is invalid");
    }
    return {
      error: {
        code: error.code as LauncherErrorCode,
        message: error.message,
      },
      ok: false,
      protocolVersion: LAUNCHER_RPC_PROTOCOL,
      requestId: id,
    };
  }
  throw new Error("launcher response outcome is invalid");
}

export function encodeLauncherRpcResponse(
  response: LauncherRpcResponse,
): string {
  return JSON.stringify(response);
}
