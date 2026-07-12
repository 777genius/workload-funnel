import {
  encodeLauncherRpcRequest,
  LAUNCHER_RPC_PROTOCOL,
  type LauncherRpcRequest,
  type LauncherRpcResponse,
  parseLauncherRpcResponse,
  type UnixLauncherRpcTransport,
  type UnixPeerIdentity,
} from "@workload-funnel/node-execution/process-lifecycle";

export class LauncherPeerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LauncherPeerError";
  }
}

export interface LauncherSocketClientConfig {
  readonly launcherGid: number;
  readonly launcherUid: number;
  readonly transport: UnixLauncherRpcTransport;
}

export class LauncherSocketClient {
  public constructor(private readonly config: LauncherSocketClientConfig) {}

  public start(
    requestId: string,
    ticket: LauncherRpcRequest["ticket"],
  ): LauncherRpcResponse {
    return this.call("start", requestId, ticket);
  }

  public observe(
    requestId: string,
    ticket: LauncherRpcRequest["ticket"],
  ): LauncherRpcResponse {
    return this.call("observe", requestId, ticket);
  }

  public stop(
    requestId: string,
    ticket: LauncherRpcRequest["ticket"],
  ): LauncherRpcResponse {
    return this.call("stop", requestId, ticket);
  }

  private call(
    method: "observe" | "start" | "stop",
    requestId: string,
    ticket: LauncherRpcRequest["ticket"],
  ): LauncherRpcResponse {
    const exchange = this.config.transport.exchange(
      encodeLauncherRpcRequest({
        method,
        protocolVersion: LAUNCHER_RPC_PROTOCOL,
        requestId,
        ticket,
      }),
    );
    this.assertLauncherPeer(exchange.peer);
    const response = parseLauncherRpcResponse(exchange.payload);
    if (response.requestId !== requestId) {
      throw new LauncherPeerError(
        "launcher response request identity mismatch",
      );
    }
    return response;
  }

  private assertLauncherPeer(peer: unknown): asserts peer is UnixPeerIdentity {
    if (typeof peer !== "object" || peer === null) {
      throw new LauncherPeerError(
        "launcher Unix peer is not trusted root identity",
      );
    }
    const candidate = peer as {
      readonly gid?: unknown;
      readonly pid?: unknown;
      readonly transport?: unknown;
      readonly uid?: unknown;
    };
    if (
      candidate.transport !== "unix" ||
      candidate.uid !== this.config.launcherUid ||
      candidate.gid !== this.config.launcherGid ||
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid as number) <= 0
    ) {
      throw new LauncherPeerError(
        "launcher Unix peer is not trusted root identity",
      );
    }
  }
}
