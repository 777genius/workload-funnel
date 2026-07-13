import { describe, expect, it } from "vitest";

import { createPhase5TestFixture } from "../../../../../control-service/src/features/walking-slice/tests/phase5-test-fixture.js";

import { createOperatorCli } from "../index.js";

describe("Phase 5 operator CLI", () => {
  it("executes bounded SDK operations and emits machine-readable output", async () => {
    const fixture = createPhase5TestFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = createOperatorCli({
      io: Object.freeze({
        stderr: (value: string) => stderr.push(value),
        stdout: (value: string) => stdout.push(value),
      }),
      tenantId: "synthetic-tenant",
      transport: fixture.transport,
    });
    const workload = JSON.stringify({
      command: ["synthetic", "cli"],
      processProfile: "trusted-synthetic-v1",
      resources: { cpuMillis: 100, memoryMiB: 64 },
      resultFiles: [],
      schemaVersion: 1,
      syntheticOutcome: "succeeded",
    });
    expect(await cli.run(["submit", workload, "cli-submit"])).toBe(0);
    expect(JSON.parse(stdout[0] ?? "{}")).toMatchObject({
      runId: "run-0001",
    });
    expect(await cli.run(["capacity"])).toBe(0);
    expect(await cli.run(["unknown"])).toBe(2);
    expect(JSON.parse(stderr[0] ?? "{}")).toEqual({
      error: "unknown_command",
    });
  });
});
