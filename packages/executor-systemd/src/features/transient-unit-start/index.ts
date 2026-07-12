export const SYNTHETIC_EXECUTABLE =
  "/usr/libexec/workload-funnel/synthetic-process-tree" as const;
export const SYNTHETIC_SERVICE_USER = "workload-funnel-synthetic" as const;
export const SYNTHETIC_WORKING_DIRECTORY = "/var/empty" as const;

export interface SystemdExecCommand {
  readonly arguments: readonly [typeof SYNTHETIC_EXECUTABLE, "--phase4a-tree"];
  readonly ignoreFailure: false;
  readonly path: typeof SYNTHETIC_EXECUTABLE;
}

export interface SyntheticTransientUnit {
  readonly description: "WorkloadFunnel Phase 4A synthetic process tree";
  readonly execStart: readonly [SystemdExecCommand];
  readonly properties: Readonly<{
    readonly finalKillSignal: "SIGKILL";
    readonly group: typeof SYNTHETIC_SERVICE_USER;
    readonly killMode: "control-group";
    readonly killSignal: "SIGTERM";
    readonly noNewPrivileges: true;
    readonly privateTmp: true;
    readonly protectHome: true;
    readonly protectSystem: "strict";
    readonly sendSigkill: true;
    readonly tasksMax: 64;
    readonly timeoutStopMicroseconds: 5_000_000;
    readonly user: typeof SYNTHETIC_SERVICE_USER;
    readonly workingDirectory: typeof SYNTHETIC_WORKING_DIRECTORY;
  }>;
  readonly startMode: "fail";
  readonly unitName: string;
}

export interface TransientUnitStartManager {
  readonly transientServiceStart: "supported" | "unsupported";
  startTransientService(unit: SyntheticTransientUnit): "created" | "exists";
}

export type TransientUnitStartResult =
  | { readonly status: "started"; readonly unitName: string }
  | {
      readonly evidence: "systemd_transient_service_start_unsupported";
      readonly status: "unsupported";
    };

function assertUnitName(unitName: string): void {
  if (!/^workload-funnel-phase4a-[a-f0-9]{32}\.service$/u.test(unitName)) {
    throw new Error("deterministic unit name is invalid");
  }
}

export function syntheticTransientUnit(
  unitName: string,
): SyntheticTransientUnit {
  assertUnitName(unitName);
  return Object.freeze({
    description: "WorkloadFunnel Phase 4A synthetic process tree",
    execStart: Object.freeze([
      Object.freeze({
        arguments: Object.freeze([
          SYNTHETIC_EXECUTABLE,
          "--phase4a-tree",
        ] as const),
        ignoreFailure: false,
        path: SYNTHETIC_EXECUTABLE,
      }),
    ]) as SyntheticTransientUnit["execStart"],
    properties: Object.freeze({
      finalKillSignal: "SIGKILL",
      group: SYNTHETIC_SERVICE_USER,
      killMode: "control-group",
      killSignal: "SIGTERM",
      noNewPrivileges: true,
      privateTmp: true,
      protectHome: true,
      protectSystem: "strict",
      sendSigkill: true,
      tasksMax: 64,
      timeoutStopMicroseconds: 5_000_000,
      user: SYNTHETIC_SERVICE_USER,
      workingDirectory: SYNTHETIC_WORKING_DIRECTORY,
    }),
    startMode: "fail",
    unitName,
  });
}

export function startSyntheticTransientUnit(
  manager: TransientUnitStartManager,
  unitName: string,
): TransientUnitStartResult {
  if (manager.transientServiceStart !== "supported") {
    return {
      evidence: "systemd_transient_service_start_unsupported",
      status: "unsupported",
    };
  }
  manager.startTransientService(syntheticTransientUnit(unitName));
  return { status: "started", unitName };
}
