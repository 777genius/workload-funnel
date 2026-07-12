import { describe, expect, it } from "vitest";

import * as postgres from "./composition.control-postgres.js";
import * as sqlite from "./composition.control-sqlite.js";

describe.each([
  ["Postgres", postgres],
  ["SQLite", sqlite],
])("%s Phase 0 control profile", (_name, profile) => {
  it("constructs without later-phase scheduler or provider runtime capability", () => {
    const service = profile.createControlService();

    expect(Object.isFrozen(service)).toBe(true);
    expect(
      service.evaluateCapabilityRequirements([
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
});

describe("control-postgres Phase 0 profile", () => {
  it("fails closed when artifact capabilities are absent", () => {
    const service = postgres.createControlService();

    expect(
      service.evaluateCapabilityRequirements([
        "artifact_retention_deletion",
        "artifact_verification",
      ]),
    ).toEqual({
      missingCapabilities: [
        "artifact_retention_deletion",
        "artifact_verification",
      ],
      status: "unschedulable_missing_capability",
    });
  });
});

describe("control-sqlite Phase 0 profile", () => {
  it("declares only its fixed local and filesystem capability surface", () => {
    const service = sqlite.createControlService();

    expect(
      service.evaluateCapabilityRequirements([
        "artifact_retention_deletion",
        "artifact_verification",
        "local_dispatch",
      ]),
    ).toEqual({ status: "satisfied" });
  });
});
