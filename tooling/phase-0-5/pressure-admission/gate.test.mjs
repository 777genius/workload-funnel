import { describe, expect, it } from "vitest";

import {
  decidePressureAdmission,
  runBoundedSyntheticPressure,
  runPressureAdmissionGate,
} from "./gate.mjs";

const limits = { cpu: 0.9, disk: 0.9, inodes: 0.9, io: 0.9, memory: 0.9 };
const healthy = {
  cpu: 0.1,
  disk: 0.1,
  inodes: 0.1,
  io: 0.1,
  memory: 0.1,
  status: "fresh",
};

describe("Phase 0.5 pressure and admission gate", () => {
  it.each(["cpu", "memory", "io", "disk", "inodes"])(
    "closes admission before %s exhaustion",
    (dimension) => {
      expect(
        decidePressureAdmission({ ...healthy, [dimension]: 0.95 }, limits),
      ).toEqual({ reason: `${dimension}_pressure`, status: "closed" });
    },
  );

  it.each(["stale", "failed"])("fails closed for a %s sensor", (status) => {
    expect(decidePressureAdmission({ status }, limits)).toEqual({
      reason: `sensor_${status}`,
      status: "closed",
    });
  });

  it("fails closed for an incomplete pressure policy", () => {
    expect(
      decidePressureAdmission(healthy, { ...limits, disk: undefined }),
    ).toEqual({
      reason: "policy_invalid_disk",
      status: "closed",
    });
  });

  it("keeps a synthetic control callback responsive under bounded load", async () => {
    const result = await runBoundedSyntheticPressure();

    expect(result.responseMilliseconds).toBeLessThan(1_000);
    expect(result.dimensions).toEqual([
      "cpu",
      "memory",
      "io",
      "disk",
      "inodes",
    ]);
    await expect(runPressureAdmissionGate()).resolves.toMatchObject({
      reasonCode: "host_saturation_isolation_unverified",
      status: "unsupported",
    });
  });
});
