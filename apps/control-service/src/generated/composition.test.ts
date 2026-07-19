import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

describe("control-postgres production profile", () => {
  it("has no unconditional production start switch", () => {
    expect(
      postgres.evaluateCapabilityRequirements([
        "bounded_capacity_reservation",
        "postgres_atomic_acceptance",
      ]),
    ).toEqual({ status: "satisfied" });
    expect(postgres.productionStartsEnabled).toBe(false);
    expect(() => postgres.refuseUnverifiedProductionStart()).toThrow(
      "production_starts_disabled",
    );
    expect(postgres.requiredProductionCapabilities).toEqual(
      expect.arrayContaining([
        "authenticated_mtls_transport",
        "postgres_schema_v2",
        "immutable_execution_generation_fencing",
        "scheduler_mutation_gateway",
      ]),
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

describe("control-postgres config entrypoint", () => {
  it("opens only an owner-private, no-follow, bounded config document", async () => {
    const root = await mkdtemp(join(tmpdir(), "wf-control-config-"));
    try {
      const path = join(root, "control.json");
      await writeFile(path, JSON.stringify({ database: {}, server: {} }), {
        mode: 0o600,
      });
      await expect(postgres.loadControlServiceOptions(path)).resolves.toEqual({
        database: {},
        server: {},
      });

      await chmod(path, 0o644);
      await expect(postgres.loadControlServiceOptions(path)).rejects.toThrow(
        "production_config_file_unsafe",
      );
      await chmod(path, 0o600);
      const link = join(root, "control-link.json");
      await symlink(path, link);
      await expect(
        postgres.loadControlServiceOptions(link),
      ).rejects.toBeDefined();
      await expect(
        postgres.loadControlServiceOptions("relative-control.json"),
      ).rejects.toThrow("production_config_path_invalid");
      await writeFile(path, JSON.stringify({ "database,server": {} }));
      await expect(postgres.loadControlServiceOptions(path)).rejects.toThrow(
        "production_config_file_invalid",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
