export interface DisabledNodeAgentStartEvidence {
  readonly capability: "production_node_agent";
  readonly reason: "phase_4a_production_start_disabled";
  readonly status: "unsupported";
}

export function startNodeAgent(): DisabledNodeAgentStartEvidence {
  return {
    capability: "production_node_agent",
    reason: "phase_4a_production_start_disabled",
    status: "unsupported",
  };
}
