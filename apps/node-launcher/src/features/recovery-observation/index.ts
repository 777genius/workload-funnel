import type {
  RootAuthorityRegistry,
  StartWalRecord,
} from "@workload-funnel/node-launcher/authority-registry";

export interface RecoveredUnitObservation {
  readonly invocationId?: string;
  readonly state: "active" | "failed" | "inactive" | "absent" | "unknown";
  readonly unitName: string;
}

export interface LauncherRecoveryEntry {
  readonly launcherState:
    | "redeemed"
    | "systemd_call_issued"
    | "started_or_unknown";
  readonly nonce: string;
  readonly operationId: string;
  readonly ticketDigest: string;
  readonly unit: RecoveredUnitObservation;
}

export interface LauncherRecoveryReport {
  readonly cordoned: boolean;
  readonly entries: readonly LauncherRecoveryEntry[];
  readonly mutationReady: boolean;
  readonly reason?: "launcher_registry_unprovable" | "unknown_start_outcome";
}

export function recoverLauncherObservations(
  registry: RootAuthorityRegistry,
  inventory: (unitName: string) => RecoveredUnitObservation,
): LauncherRecoveryReport {
  if (registry.cordoned) {
    return {
      cordoned: true,
      entries: [],
      mutationReady: false,
      reason: "launcher_registry_unprovable",
    };
  }
  const starts = new Map<string, StartWalRecord>();
  for (const recovered of registry.wal.records) {
    if (recovered.record.kind === "start_state") {
      const record = recovered.record;
      starts.set(
        `${record.clusterIncarnation}\u0000${record.issuerKeyId}\u0000${record.nonce}`,
        record,
      );
    }
  }
  const entries = [...starts.values()].map((record) =>
    Object.freeze({
      launcherState: record.state,
      nonce: record.nonce,
      operationId: record.operationId,
      ticketDigest: record.ticketDigest,
      unit: inventory(record.unitName),
    }),
  );
  const unknown = entries.some(
    (entry) =>
      entry.launcherState === "systemd_call_issued" ||
      (entry.launcherState === "started_or_unknown" &&
        entry.unit.state === "unknown"),
  );
  return unknown
    ? {
        cordoned: false,
        entries,
        mutationReady: false,
        reason: "unknown_start_outcome",
      }
    : { cordoned: false, entries, mutationReady: true };
}
