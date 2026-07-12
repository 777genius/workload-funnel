export interface DisabledLocalNodeAgentStartEvidence {
  readonly capability: "host_node_agent";
  readonly reason: "phase_4a_host_start_requires_synthetic_fixture";
  readonly status: "unsupported";
}

export function startNodeAgent(): DisabledLocalNodeAgentStartEvidence {
  return {
    capability: "host_node_agent",
    reason: "phase_4a_host_start_requires_synthetic_fixture",
    status: "unsupported",
  };
}
