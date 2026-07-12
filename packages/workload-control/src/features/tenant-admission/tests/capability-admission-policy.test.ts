import { describe, expect, it } from "vitest";

import {
  CapabilityRequirement,
  InvalidCapabilityRequirementError,
  type CapabilityName,
  createCapabilityRequirementEvaluator,
  decideCapabilityAdmission,
} from "../index.js";

describe("capability admission", () => {
  it("compares capability requirements by immutable value", () => {
    const requirement = CapabilityRequirement.from("local_dispatch");

    expect(
      requirement.equals(CapabilityRequirement.from("local_dispatch")),
    ).toBe(true);
    expect(
      requirement.equals(CapabilityRequirement.from("artifact_verification")),
    ).toBe(false);
    expect(Object.isFrozen(requirement)).toBe(true);
  });

  it("accepts a workload only when every required capability is available", () => {
    const evaluate = createCapabilityRequirementEvaluator([
      "artifact_verification",
      "local_dispatch",
    ]);

    expect(evaluate(["local_dispatch", "artifact_verification"])).toEqual({
      status: "satisfied",
    });
  });

  it("fails closed with a stable typed decision and no silent downgrade", () => {
    const evaluate = createCapabilityRequirementEvaluator(["local_dispatch"]);

    expect(
      evaluate([
        "provider_runtime_execution",
        "external_scheduler_dispatch",
        "provider_runtime_execution",
      ]),
    ).toEqual({
      missingCapabilities: [
        "external_scheduler_dispatch",
        "provider_runtime_execution",
      ],
      status: "unschedulable_missing_capability",
    });
  });

  it("rejects unrecognized requirements at the domain boundary", () => {
    expect(() => CapabilityRequirement.from("raw_process_launch")).toThrow(
      InvalidCapabilityRequirementError,
    );
  });

  it("does not copy rejected values into errors", () => {
    const secretLikeValue = "secret-value-that-must-not-be-logged";

    expect(() => CapabilityRequirement.from(secretLikeValue)).toThrow(
      "Unsupported capability requirement",
    );
    expect(() => CapabilityRequirement.from(secretLikeValue)).not.toThrow(
      secretLikeValue,
    );
  });

  it("does not expose mutable decision collections", () => {
    const decision = decideCapabilityAdmission(
      [CapabilityRequirement.from("artifact_retention_deletion")],
      new Set<CapabilityName>(),
    );

    expect(decision.status).toBe("unschedulable_missing_capability");
    if (decision.status === "unschedulable_missing_capability") {
      expect(Object.isFrozen(decision.missingCapabilities)).toBe(true);
      expect(Object.isFrozen(decision)).toBe(true);
    }
  });
});
