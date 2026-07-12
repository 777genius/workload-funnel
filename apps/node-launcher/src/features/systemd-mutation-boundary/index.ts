import { createHash } from "node:crypto";

import type { MutationFence } from "@workload-funnel/kernel";

import type { SystemdCapabilityReport } from "@workload-funnel/executor-systemd/capability-discovery";
import {
  createSyntheticSandboxProfile,
  fingerprintSyntheticSandboxProfile,
  mapSystemdExecutionControls,
} from "@workload-funnel/executor-systemd/cgroup-resource-mapping";
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
  type BreakGlassStopInput,
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
  validateControlPartitionPolicy,
} from "@workload-funnel/node-execution/process-lifecycle";

export type Phase4aSystemdManager = TransientUnitCancellationManager &
  TransientUnitObservationManager &
  TransientUnitStartManager & {
    readonly externalFenceEnforced: boolean;
    readonly resourceCapabilities: SystemdCapabilityReport;
  };
export type EmergencyStopInput = BreakGlassStopInput;

export interface LauncherMutationBoundaryConfig {
  readonly agentGid: number;
  readonly agentUid: number;
  readonly controlAuthority: {
    readonly disconnectedAtMs: () => number | undefined;
    readonly nowMs: () => number;
  };
  readonly manager: Phase4aSystemdManager;
  readonly partitionGraceMs: number;
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
  public constructor(private readonly config: LauncherMutationBoundaryConfig) {
    if (
      !Number.isSafeInteger(config.partitionGraceMs) ||
      config.partitionGraceMs < 0
    ) {
      throw new Error("control-partition grace must be a non-negative integer");
    }
  }

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
        const code: LauncherErrorCode =
          error.code === "launcher_cordoned"
            ? "launcher_cordoned"
            : error.code === "nonce_replay"
              ? "replay_rejected"
              : "authority_mismatch";
        return encodeLauncherRpcResponse(
          failure(
            request.requestId,
            code,
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

  public emergencyStop(input: BreakGlassStopInput): "stopped" | "unknown" {
    return this.config.registry.runBreakGlassStop(input, () => {
      const result = stopSyntheticTransientUnit(
        this.config.manager,
        input.unitName,
        input.mutationFence,
        "break_glass",
      );
      if (result.status === "unsupported") {
        throw new Error(result.evidence);
      }
    });
  }

  public enforceControlPartition(
    untrustedTicket: unknown,
    disconnectedAtMs: number,
    nowMs: number,
  ): {
    readonly state: "scheduled" | "stopped" | "unknown";
    readonly stopAtMs: number;
  } {
    const claims = this.config.ticketVerifier.verify(untrustedTicket, true);
    if (claims.mutationFence.desiredEffect !== "process_start") {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "control-partition policy must bind the durable start ticket",
      );
    }
    const unitName = deterministicUnitName(claims);
    return this.enforceVerifiedControlPartition(
      claims,
      unitName,
      disconnectedAtMs,
      nowMs,
    );
  }

  public reconcileControlPartitionDeadlines(nowMs: number): number {
    return this.config.registry.reconcileControlPartitionDeadlines(
      nowMs,
      (start) => {
        const result = stopSyntheticTransientUnit(
          this.config.manager,
          start.unitName,
          start.mutationFence,
          "control_partition",
        );
        if (result.status === "unsupported") throw new Error(result.evidence);
      },
    );
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
    const safetyOperation = request.method === "observe";
    const claims = this.config.ticketVerifier.verify(
      request.ticket,
      safetyOperation,
    );
    const mutationFence: MutationFence = claims.mutationFence;
    const unitName = deterministicUnitName(claims);
    if (
      claims.sandboxProfileDigest !==
      fingerprintSyntheticSandboxProfile(claims.allocation.allocationId)
    ) {
      throw new RootTicketVerificationError("sandbox_profile_digest_mismatch");
    }
    const disconnectedAtMs = this.config.controlAuthority.disconnectedAtMs();
    if (disconnectedAtMs !== undefined) {
      const nowMs = this.config.controlAuthority.nowMs();
      if (request.method === "start") {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "isolated launcher cannot accept new work",
        );
      }
      this.reconcileControlPartitionDeadlines(nowMs);
      if (mutationFence.desiredEffect === "process_start") {
        this.enforceVerifiedControlPartition(
          claims,
          unitName,
          disconnectedAtMs,
          nowMs,
        );
      }
    }

    if (request.method === "start") {
      if (mutationFence.desiredEffect !== "process_start") {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "start requires an installed process_start tuple",
        );
      }
      if (this.config.manager.transientServiceStart !== "supported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          "systemd_transient_service_start_unsupported",
        );
      }
      if (this.config.manager.projectQuotaControl !== "supported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          "ephemeral_project_quota_unsupported",
        );
      }
      validateControlPartitionPolicy(claims.partitionPolicy, "side_effectful", {
        externalFenceEnforced: this.config.manager.externalFenceEnforced,
      });
      const controls = mapSystemdExecutionControls(
        createSyntheticSandboxProfile(claims.allocation.allocationId),
        this.config.manager.resourceCapabilities,
        "synthetic_disposable_linux_fixture",
      );
      if (controls.status === "unsupported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          controls.missingCapabilities.join(",") || controls.reason,
        );
      }
      if (controls.profileDigest !== claims.sandboxProfileDigest)
        throw new RootTicketVerificationError(
          "sandbox_profile_digest_mismatch",
        );
      const ticketDigest = createHash("sha256")
        .update(JSON.stringify(request.ticket), "utf8")
        .digest("hex");
      const authorized = this.config.registry.runAuthorizedStart(
        claims,
        unitName,
        ticketDigest,
        () =>
          startSyntheticTransientUnit(
            this.config.manager,
            unitName,
            mutationFence,
            controls,
          ),
      );
      if (authorized.state === "unknown") {
        return {
          ok: true,
          protocolVersion: LAUNCHER_RPC_PROTOCOL,
          requestId: request.requestId,
          result: { state: "unknown", unitName },
        };
      }
      if (authorized.result?.status === "unsupported") {
        return failure(
          request.requestId,
          "unsupported_host_capability",
          authorized.result.evidence,
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

    if (mutationFence.desiredEffect !== "process_stop") {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "stop requires an installed process_stop tuple",
      );
    }
    const ticketDigest = createHash("sha256")
      .update(JSON.stringify(request.ticket), "utf8")
      .digest("hex");
    let unsupportedEvidence: string | undefined;
    const state = this.config.registry.runAuthorizedStop(
      claims,
      unitName,
      ticketDigest,
      () => {
        const result = stopSyntheticTransientUnit(
          this.config.manager,
          unitName,
          mutationFence,
          "fenced_stop",
        );
        if (result.status === "unsupported") {
          unsupportedEvidence = result.evidence;
          throw new Error(result.evidence);
        }
      },
    );
    if (unsupportedEvidence !== undefined) {
      return failure(
        request.requestId,
        "unsupported_host_capability",
        unsupportedEvidence,
      );
    }
    return {
      ok: true,
      protocolVersion: LAUNCHER_RPC_PROTOCOL,
      requestId: request.requestId,
      result: { state, unitName },
    };
  }

  private enforceVerifiedControlPartition(
    claims: ReturnType<RootExecutionTicketVerifier["verify"]>,
    unitName: string,
    disconnectedAtMs: number,
    nowMs: number,
  ): {
    readonly state: "scheduled" | "stopped" | "unknown";
    readonly stopAtMs: number;
  } {
    validateControlPartitionPolicy(claims.partitionPolicy, "side_effectful", {
      externalFenceEnforced: this.config.manager.externalFenceEnforced,
    });
    const stopAtMs =
      claims.partitionPolicy === "terminate_after_grace"
        ? disconnectedAtMs + this.config.partitionGraceMs
        : Math.max(disconnectedAtMs, claims.expiresAtMs);
    return this.config.registry.runControlPartition(
      { claims, disconnectedAtMs, nowMs, stopAtMs, unitName },
      () => {
        const result = stopSyntheticTransientUnit(
          this.config.manager,
          unitName,
          claims.mutationFence,
          "control_partition",
        );
        if (result.status === "unsupported") throw new Error(result.evidence);
      },
    );
  }
}
