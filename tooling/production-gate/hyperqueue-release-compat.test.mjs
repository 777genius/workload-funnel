import { describe, expect, it } from "vitest";

import { exactOfficialHyperQueueVersion } from "./hyperqueue-contract.mjs";

describe("HyperQueue 0.26.2 release compatibility", () => {
  it("accepts only the exact official release version output", () => {
    expect(
      exactOfficialHyperQueueVersion({
        code: 0,
        stderr: "",
        stdout: "hyperqueue v0.26.2\n",
      }),
    ).toBe(true);
    for (const observed of [
      { code: 0, stderr: "", stdout: "hq 0.26.2\n" },
      { code: 0, stderr: "", stdout: "hyperqueue 0.26.2\n" },
      { code: 0, stderr: "", stdout: "hyperqueue v0.26.2" },
      { code: 0, stderr: "", stdout: "hyperqueue v0.26.2\n\n" },
      { code: 0, stderr: "", stdout: "hyperqueue v0.26.3\n" },
      { code: 0, stderr: "warning\n", stdout: "hyperqueue v0.26.2\n" },
      { code: 1, stderr: "", stdout: "hyperqueue v0.26.2\n" },
    ])
      expect(exactOfficialHyperQueueVersion(observed)).toBe(false);
  });
});
