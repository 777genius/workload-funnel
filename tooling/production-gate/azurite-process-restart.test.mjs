import { describe, expect, it } from "vitest";

import {
  parseAzuriteSupervisorState,
  proveAzuriteProcessRestart,
} from "./azurite-process-restart.mjs";

const identity = "a".repeat(64);
const before = Object.freeze({
  generation: 1,
  serverPid: 11,
  supervisorPid: 7,
});
const after = Object.freeze({
  generation: 2,
  serverPid: 12,
  supervisorPid: 7,
});

describe("Azurite process restart evidence", () => {
  it("parses only the exact supervisor state schema", () => {
    expect(
      parseAzuriteSupervisorState(
        "workload-funnel.azurite-supervisor.v1|7|2|12",
      ),
    ).toEqual(after);
    for (const malformed of [
      "",
      "workload-funnel.azurite-supervisor.v1|7|2|0",
      "workload-funnel.azurite-supervisor.v1|7|2|12\nextra",
      "workload-funnel.minio-supervisor.v1|7|2|12",
    ])
      expect(() => parseAzuriteSupervisorState(malformed)).toThrow(
        "azurite_restart_evidence_malformed",
      );
  });

  it("proves a changed server generation inside a stable container boundary", () => {
    expect(
      proveAzuriteProcessRestart({
        after,
        before,
        containerBoundaryPidAfter: 100,
        containerBoundaryPidBefore: 100,
        containerIdentity: identity,
      }),
    ).toMatchObject({
      containerBoundaryStable: true,
      containerIdentity: identity,
      containerIdentityStable: true,
      currentServerGeneration: 2,
      currentServerPid: 12,
      previousServerGeneration: 1,
      previousServerPid: 11,
      serverProcessGenerationChanged: true,
      serverProcessPidChanged: true,
      supervisorBoundaryStable: true,
    });
  });

  it.each([
    { after: { ...after, generation: 1 } },
    { after: { ...after, serverPid: 11 } },
    { after: { ...after, supervisorPid: 8 } },
    { containerBoundaryPidAfter: 101 },
    { containerIdentity: "foreign" },
  ])("rejects stale or foreign restart evidence", (override) => {
    expect(() =>
      proveAzuriteProcessRestart({
        after,
        before,
        containerBoundaryPidAfter: 100,
        containerBoundaryPidBefore: 100,
        containerIdentity: identity,
        ...override,
      }),
    ).toThrow("azurite_restart_evidence_stale");
  });
});
