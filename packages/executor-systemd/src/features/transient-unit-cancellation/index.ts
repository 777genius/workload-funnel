import {
  type MutationFence,
  validateMutationFence,
} from "@workload-funnel/kernel";

export interface TransientUnitCancellationManager {
  readonly controlGroupStop: "supported" | "unsupported";
  stopTransientService(unitName: string, mode: "replace"): "absent" | "stopped";
}

export type TransientUnitCancellationResult =
  | { readonly status: "stopped"; readonly unitName: string }
  | {
      readonly evidence: "systemd_control_group_stop_unsupported";
      readonly status: "unsupported";
    };

export function stopSyntheticTransientUnit(
  manager: TransientUnitCancellationManager,
  unitName: string,
  mutationFence: MutationFence,
  mutationKind: "break_glass" | "control_partition" | "fenced_stop",
): TransientUnitCancellationResult {
  if (manager.controlGroupStop !== "supported") {
    return {
      evidence: "systemd_control_group_stop_unsupported",
      status: "unsupported",
    };
  }
  validateMutationFence(mutationFence);
  if (
    (mutationKind === "fenced_stop" &&
      mutationFence.desiredEffect !== "process_stop") ||
    ((mutationKind === "break_glass" || mutationKind === "control_partition") &&
      !["process_start", "process_stop"].includes(mutationFence.desiredEffect))
  ) {
    throw new Error("transient_unit_cancellation_fence_mismatch");
  }
  manager.stopTransientService(unitName, "replace");
  return { status: "stopped", unitName };
}
