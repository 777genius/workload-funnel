import { describe, expect, it } from "vitest";

import * as postgres from "./composition.control-postgres.js";
import * as sqlite from "./composition.control-sqlite.js";

describe("SQLite Phase 0 control profile", () => {
  it("constructs without later-phase scheduler or provider runtime capability", () => {
    const service = sqlite.createControlService();

    expect(Object.isFrozen(service)).toBe(true);
    expect(service.phase1.participantCount).toBe(7);
    expect(service.phase1.profile).toBe("sqlite");
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
  it("declares atomic acceptance without enabling production starts", () => {
    expect(
      postgres.evaluateCapabilityRequirements([
        "bounded_capacity_reservation",
        "postgres_atomic_acceptance",
      ]),
    ).toEqual({ status: "satisfied" });
    expect(postgres.productionStartsEnabled).toBe(false);
    expect(() => postgres.startControlService()).toThrow(
      "production_starts_disabled",
    );
  });

  it("fails closed when artifact capabilities are absent", () => {
    expect(
      postgres.evaluateCapabilityRequirements([
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
        "bounded_capacity_reservation",
        "local_dispatch",
      ]),
    ).toEqual({ status: "satisfied" });
  });
});
