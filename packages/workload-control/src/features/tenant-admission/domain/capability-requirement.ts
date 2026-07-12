const capabilityNames = [
  "artifact_retention_deletion",
  "artifact_verification",
  "bounded_capacity_reservation",
  "deterministic_systemd_process_ownership",
  "external_scheduler_dispatch",
  "foreground_runtime_ownership",
  "hyperqueue_ambiguous_submit_reconciliation",
  "local_dispatch",
  "pinned_execution_paths",
  "postgres_atomic_acceptance",
  "pressure_fail_closed_admission",
  "provider_runtime_execution",
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
