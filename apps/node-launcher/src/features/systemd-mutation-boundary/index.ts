import { createHash } from "node:crypto";

import {
  stopSyntheticTransientUnit,
  type TransientUnitCancellationManager,
} from "@workload-funnel/executor-systemd/transient-unit-cancellation";
import {
  observeSyntheticTransientUnit,
  type TransientUnitObservationManager,
} from "@workload-funnel/executor-systemd/transient-unit-observation";
import {
  startSyntheticTransientUnit,
  type TransientUnitStartManager,
} from "@workload-funnel/executor-systemd/transient-unit-start";
import {
  AuthorityRegistryError,
  type RootAuthorityRegistry,
  type RootExecutionTicketVerifier,
  RootTicketVerificationError,
} from "@workload-funnel/node-launcher/authority-registry";
import {
  encodeLauncherRpcResponse,
  LAUNCHER_RPC_PROTOCOL,
  type LauncherErrorCode,
  type LauncherRpcRequest,
  type LauncherRpcResponse,
  parseLauncherRpcRequest,
  type UnixPeerIdentity,
} from "@workload-funnel/node-execution/process-lifecycle";

export type Phase4aSystemdManager = TransientUnitCancellationManager &
  TransientUnitObservationManager &
  TransientUnitStartManager;

export interface LauncherMutationBoundaryConfig {
  readonly agentGid: number;
  readonly agentUid: number;
  readonly manager: Phase4aSystemdManager;
  readonly registry: RootAuthorityRegistry;
  readonly ticketVerifier: RootExecutionTicketVerifier;
}

function deterministicUnitName(
  claims: ReturnType<RootExecutionTicketVerifier["verify"]>,
): string {
  const identity = [
    claims.node.nodeId,
    claims.node.bootId,
    claims.allocation.allocationId,
    claims.attempt.attemptId,
    claims.attempt.executionGeneration,
  ].join("\u0000");
  const digest = createHash("sha256").update(identity, "utf8").digest("hex");
  return `workload-funnel-phase4a-${digest.slice(0, 32)}.service`;
}

function failure(
  requestId: string,
  code: LauncherErrorCode,
  message: string,
): LauncherRpcResponse {
  return {
    error: { code, message },
    ok: false,
    protocolVersion: LAUNCHER_RPC_PROTOCOL,
    requestId,
  };
}

export class LauncherMutationBoundary {
  public constructor(private readonly config: LauncherMutationBoundaryConfig) {}

  public handle(payload: string, peer: unknown): string {
    if (!this.isTrustedAgent(peer)) {
      return encodeLauncherRpcResponse(
        failure(
          "rejected",
          "peer_not_authorized",
          "Unix peer is not authorized",
        ),
      );
    }
    let request: LauncherRpcRequest;
    try {
      request = parseLauncherRpcRequest(payload);
    } catch {
      return encodeLauncherRpcResponse(
        failure("rejected", "malformed_request", "request schema rejected"),
      );
    }
    try {
      return encodeLauncherRpcResponse(this.execute(request));
    } catch (error) {
      if (error instanceof RootTicketVerificationError) {
        return encodeLauncherRpcResponse(
          failure(
            request.requestId,
            "ticket_rejected",
            `ticket rejected: ${error.reason}`,
          ),
        );
      }
      if (error instanceof AuthorityRegistryError) {
        return encodeLauncherRpcResponse(
          failure(
            request.requestId,
            "authority_mismatch",
            `root authority rejected: ${error.code}`,
          ),
        );
      }
      return encodeLauncherRpcResponse(
        failure(
          request.requestId,
          "unsupported_host_capability",
          "host mutation failed closed",
        ),
      );
    }
  }

  private isTrustedAgent(peer: unknown): peer is UnixPeerIdentity {
    if (typeof peer !== "object" || peer === null) return false;
    const candidate = peer as {
      readonly gid?: unknown;
      readonly pid?: unknown;
      readonly transport?: unknown;
      readonly uid?: unknown;
    };
    return (
      candidate.transport === "unix" &&
      candidate.uid === this.config.agentUid &&
      candidate.gid === this.config.agentGid &&
      Number.isSafeInteger(candidate.pid) &&
      (candidate.pid as number) > 0
    );
  }

  private execute(request: LauncherRpcRequest): LauncherRpcResponse {
    const safetyOperation = request.method !== "start";
    const claims = this.config.ticketVerifier.verify(
      request.ticket,
      safetyOperation,
    );
    const unitName = deterministicUnitName(claims);

    if (request.method === "start") {
      const result = this.config.registry.runAuthorizedStart(claims, () =>
        startSyntheticTransientUnit(this.config.manager, unitName),
      );
      if (result.status === "unsupported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          result.evidence,
        );
      }
      return {
        ok: true,
        protocolVersion: LAUNCHER_RPC_PROTOCOL,
        requestId: request.requestId,
        result: { state: "started", unitName },
      };
    }

    this.config.registry.assertKnownProcessIdentity(claims);
    if (request.method === "observe") {
      const result = observeSyntheticTransientUnit(
        this.config.manager,
        unitName,
      );
      if (result.status === "unsupported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          result.evidence,
        );
      }
      return {
        ok: true,
        protocolVersion: LAUNCHER_RPC_PROTOCOL,
        requestId: request.requestId,
        result: { state: result.state, unitName },
      };
    }

    const result = stopSyntheticTransientUnit(this.config.manager, unitName);
    if (result.status === "unsupported") {
      return failure(
        request.requestId,
        "unsupported_host_capability",
        result.evidence,
      );
    }
    return {
      ok: true,
      protocolVersion: LAUNCHER_RPC_PROTOCOL,
      requestId: request.requestId,
      result: { state: "stopped", unitName },
    };
  }
}
