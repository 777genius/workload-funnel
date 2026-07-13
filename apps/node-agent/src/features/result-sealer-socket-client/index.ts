import type {
  FeatureApi as LocalReceiptRecoveryApi,
  UnixReceiptPeerIdentity,
} from "@workload-funnel/node-execution/local-receipt-recovery";
import {
  SEAL_OUTPUT_RPC_PROTOCOL,
  type FeatureApi as ResultSealingCoordinationApi,
  type SealOutputRpcRequest,
  type SealOutputRpcResponse,
  type SignedSealOutputRequest,
} from "@workload-funnel/node-execution/result-sealing-coordination";

export interface UnixResultSealerTransport {
  exchange(payload: string): Readonly<{ peer: unknown; payload: string }>;
}

export interface ResultSealerSocketClientConfig {
  readonly sealerUid: number;
  readonly sealerGid: number;
  readonly transport: UnixResultSealerTransport;
}

export class ResultSealerPeerError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResultSealerPeerError";
  }
}

export class ResultSealerSocketClient {
  public constructor(private readonly config: ResultSealerSocketClientConfig) {}

  public seal(
    requestId: string,
    authorization: SignedSealOutputRequest,
  ): SealOutputRpcResponse {
    const request: SealOutputRpcRequest = Object.freeze({
      authorization,
      method: "seal_output",
      protocolVersion: SEAL_OUTPUT_RPC_PROTOCOL,
      requestId,
    });
    const exchange = this.config.transport.exchange(JSON.stringify(request));
    this.assertPeer(exchange.peer);
    const parsed = JSON.parse(
      exchange.payload,
    ) as Partial<SealOutputRpcResponse>;
    if (
      parsed.protocolVersion !== SEAL_OUTPUT_RPC_PROTOCOL ||
      parsed.requestId !== requestId ||
      typeof parsed.ok !== "boolean" ||
      (parsed.ok ? parsed.receipt === undefined : parsed.error === undefined)
    )
      throw new ResultSealerPeerError("invalid result-sealer RPC response");
    return parsed as SealOutputRpcResponse;
  }

  private assertPeer(value: unknown): asserts value is UnixReceiptPeerIdentity {
    if (typeof value !== "object" || value === null)
      throw new ResultSealerPeerError(
        "missing result-sealer Unix peer credentials",
      );
    const peer = value as Partial<UnixReceiptPeerIdentity>;
    if (
      peer.transport !== "unix" ||
      peer.uid !== this.config.sealerUid ||
      peer.gid !== this.config.sealerGid ||
      !Number.isSafeInteger(peer.pid) ||
      (peer.pid ?? 0) <= 0
    )
      throw new ResultSealerPeerError(
        "untrusted result-sealer Unix peer credentials",
      );
  }
}

export interface Entrypoint {
  readonly client: ResultSealerSocketClient;
  readonly localReceiptRecovery: LocalReceiptRecoveryApi;
  readonly coordination: ResultSealingCoordinationApi;
}

export function createProvider(
  input: Readonly<{
    client: ResultSealerSocketClient;
    localReceiptRecovery: LocalReceiptRecoveryApi;
    coordination: ResultSealingCoordinationApi;
  }>,
): Entrypoint {
  return Object.freeze(input);
}
