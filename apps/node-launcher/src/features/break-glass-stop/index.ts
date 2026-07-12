import type {
  EmergencyStopInput,
  LauncherMutationBoundary,
} from "@workload-funnel/node-launcher/systemd-mutation-boundary";
import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";
import type { UnixPeerIdentity } from "@workload-funnel/node-execution/process-lifecycle";

export interface RootBreakGlassStopConfig {
  readonly boundary: LauncherMutationBoundary;
  readonly operatorGid: number;
  readonly operatorUid: number;
}

export class BreakGlassStopError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BreakGlassStopError";
  }
}

function validPid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export class RootBreakGlassStop {
  public constructor(private readonly config: RootBreakGlassStopConfig) {}

  public stop(peer: unknown, input: EmergencyStopInput): "stopped" | "unknown" {
    this.assertOperator(peer);
    const mutationFence: MutationFence = input.mutationFence;
    try {
      validateMutationFence(mutationFence);
    } catch {
      throw new BreakGlassStopError("break-glass MutationFence is invalid");
    }
    if (
      !/^workload-funnel-phase4a-[a-f0-9]{32}\.service$/u.test(
        input.unitName,
      ) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.operationId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.attemptId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.executionGeneration) ||
      !/^fence-v1-[a-f0-9]{64}$/u.test(input.mutationFenceFingerprint) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.nodeBootId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.nodeId) ||
      !Number.isSafeInteger(input.nodeBootEpoch) ||
      input.nodeBootEpoch < 0 ||
      input.reason.trim().length < 8 ||
      input.reason.length > 512
    ) {
      throw new BreakGlassStopError(
        "break-glass stop request is not closed and generation-bound",
      );
    }
    return this.config.boundary.emergencyStop(input);
  }

  private assertOperator(peer: unknown): asserts peer is UnixPeerIdentity {
    const candidate = peer as Partial<UnixPeerIdentity> | null;
    if (
      candidate?.transport !== "unix" ||
      candidate.uid !== this.config.operatorUid ||
      candidate.gid !== this.config.operatorGid ||
      !validPid(candidate.pid)
    ) {
      throw new BreakGlassStopError(
        "break-glass stop requires the dedicated local operator identity",
      );
    }
  }
}
