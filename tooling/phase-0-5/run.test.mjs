import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

import { assertDecision, evidence, unsupported } from "./shared.mjs";

describe("Phase 0.5 evidence contract", () => {
  it("keeps unsupported decisions closed and requires exact host evidence", () => {
    const decision = unsupported({
      capability: "synthetic",
      evidence: [evidence("probe", false, "unavailable")],
      gateId: "synthetic_gate",
      invariantIds: ["WF-INV-015"],
      reasonCode: "host_unavailable",
      requiredHostEvidence: ["Run on a disposable host."],
    });

    expect(assertDecision(decision)).toBe(decision);
    expect(Object.isFrozen(decision.requiredHostEvidence)).toBe(true);
  });

  it("rejects a PASS containing failed evidence", () => {
    expect(() =>
      assertDecision({
        capability: "synthetic",
        evidence: [evidence("probe", false, "failed")],
        gateId: "synthetic_gate",
        invariantIds: ["WF-INV-015"],
        productionGate: "closed",
        status: "pass",
      }),
    ).toThrow("Passing decision contains failed evidence");
  });

  it("matches the checked-in evidence schema's closed production decision", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL(
          "../../docs/adr/evidence/phase-0-5.schema.json",
          import.meta.url,
        ),
      ),
    );

    expect(
      schema.properties.decisions.items.properties.productionGate.const,
    ).toBe("closed");
    const artifact = JSON.parse(
      await readFile(
        new URL(
          "../../docs/adr/evidence/phase-0-5-isolated-workspace.json",
          import.meta.url,
        ),
      ),
    );
    expect(artifact.decisions).toHaveLength(7);
    artifact.decisions.forEach(assertDecision);
  });
});
