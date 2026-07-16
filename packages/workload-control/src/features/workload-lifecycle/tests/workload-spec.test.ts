import { describe, expect, it } from "vitest";

import {
  validateWorkloadSpec,
  workloadSpecDigest,
} from "../application/workload-spec.js";

describe("workload spec canonical digest", () => {
  it("preserves canonical key order and uses a collision-resistant digest", () => {
    const spec = validateWorkloadSpec({
      syntheticOutcome: "succeeded",
      schemaVersion: 1,
      resultFiles: [],
      resources: { memoryMiB: 256, cpuMillis: 500 },
      processProfile: "trusted-synthetic-v1",
      command: ["synthetic", "succeeded"],
    });

    expect(JSON.stringify(spec)).toBe(
      '{"command":["synthetic","succeeded"],"processProfile":"trusted-synthetic-v1","resources":{"cpuMillis":500,"memoryMiB":256},"resultFiles":[],"schemaVersion":1,"syntheticOutcome":"succeeded"}',
    );
    expect(workloadSpecDigest(spec)).toBe(
      "spec-sha256-1e3a3df41b651e9834d03378a41a6596e7dc0a6fd7ce06f099cb1dbfc0534910",
    );
    expect(
      workloadSpecDigest({ ...spec, command: ["synthetic", "failed"] }),
    ).not.toBe(workloadSpecDigest(spec));
  });
});
