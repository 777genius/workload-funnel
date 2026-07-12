const capabilityNames = [
  "artifact_retention_deletion",
  "artifact_verification",
  "external_scheduler_dispatch",
  "local_dispatch",
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
