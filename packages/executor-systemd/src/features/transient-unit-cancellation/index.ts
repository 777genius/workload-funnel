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
): TransientUnitCancellationResult {
  if (manager.controlGroupStop !== "supported") {
    return {
      evidence: "systemd_control_group_stop_unsupported",
      status: "unsupported",
    };
  }
  manager.stopTransientService(unitName, "replace");
  return { status: "stopped", unitName };
}
