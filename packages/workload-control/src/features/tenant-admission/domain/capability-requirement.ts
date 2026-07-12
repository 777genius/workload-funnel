const capabilityNames = [
  "artifact_retention_deletion",
  "artifact_verification",
  "bounded_capacity_reservation",
  "deterministic_systemd_process_ownership",
  "external_scheduler_dispatch",
  "foreground_runtime_ownership",
  "hard_cpu_enforcement",
  "hard_ephemeral_disk_enforcement",
  "hard_io_enforcement",
  "hard_memory_enforcement",
  "host_control_dedicated_node",
  "host_control_direct_socket",
  "host_control_rootless_per_allocation",
  "host_control_typed_broker",
  "hyperqueue_ambiguous_submit_reconciliation",
  "local_dispatch",
  "pid_containment",
  "pinned_execution_paths",
  "postgres_atomic_acceptance",
  "pressure_fail_closed_admission",
  "process_tree_cancellation",
  "provider_runtime_execution",
  "sandbox_trusted_process_baseline",
  "strong_untrusted_workload_isolation",
] as const;

export type CapabilityName = (typeof capabilityNames)[number];

function isCapabilityName(value: unknown): value is CapabilityName {
  return (
    typeof value === "string" &&
    capabilityNames.some((candidate) => candidate === value)
  );
}

export class InvalidCapabilityRequirementError extends Error {
  public constructor() {
    super("Unsupported capability requirement");
    this.name = "InvalidCapabilityRequirementError";
  }
}

export class CapabilityRequirement {
  readonly #name: CapabilityName;

  private constructor(name: CapabilityName) {
    this.#name = name;
    Object.freeze(this);
  }

  public static from(value: unknown): CapabilityRequirement {
    if (!isCapabilityName(value)) {
      throw new InvalidCapabilityRequirementError();
    }

    return new CapabilityRequirement(value);
  }

  public get name(): CapabilityName {
    return this.#name;
  }

  public equals(other: CapabilityRequirement): boolean {
    return this.#name === other.#name;
  }
}
