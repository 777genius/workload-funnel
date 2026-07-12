export interface DisabledNodeLauncherStartEvidence {
  readonly capability: "privileged_node_launcher";
  readonly reason: "phase_4a_privileged_host_start_disabled";
  readonly status: "unsupported";
}

export function startNodeLauncher(): DisabledNodeLauncherStartEvidence {
  return {
    capability: "privileged_node_launcher",
    reason: "phase_4a_privileged_host_start_disabled",
    status: "unsupported",
  };
}
