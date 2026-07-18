import { expect, test } from "vitest";

import { validateHostCleanup, validateResidue } from "./artifacts.mjs";
import { HOSTED_GATE_SCHEMA } from "./constants.mjs";

const context = { runId: `wf-production-gate-${"a".repeat(32)}` };

test("requires certain hosted cleanup and exact zero-residue evidence", () => {
  const cleanup = {
    certain: true,
    failed: [],
    results: [{ id: "all_owned_resources", ok: true }],
    runId: context.runId,
    schemaVersion: HOSTED_GATE_SCHEMA,
  };
  const residue = {
    checks: {
      containers: "",
      groupExists: false,
      imageBaseline: [],
      imageBaselineMatches: true,
      imageInventory: [],
      imageProbesCertain: true,
      images: [],
      loopAbsent: true,
      mountAbsent: true,
      networks: [],
      packageProbesCertain: true,
      packages: [],
      paths: [],
      foreignProcesses: [],
      observedProcessCount: 42,
      ownedProcesses: [],
      processProbeCertain: true,
      units: "",
      userExists: false,
      volumes: "",
    },
    runId: context.runId,
    schemaVersion: HOSTED_GATE_SCHEMA,
    zeroResidue: true,
  };
  expect(validateHostCleanup(cleanup, context)).toBeUndefined();
  expect(validateResidue(residue, context)).toBeUndefined();
  expect(() =>
    validateHostCleanup({ ...cleanup, certain: false }, context),
  ).toThrow("host_cleanup_evidence_invalid");
  expect(() =>
    validateResidue({ ...residue, zeroResidue: false }, context),
  ).toThrow("residue_evidence_invalid");
  expect(() =>
    validateResidue(
      {
        ...residue,
        checks: { ...residue.checks, processProbeCertain: false },
      },
      context,
    ),
  ).toThrow("residue_evidence_invalid");
  expect(() =>
    validateResidue(
      {
        ...residue,
        checks: {
          ...residue.checks,
          foreignProcesses: [{ cgroup: "/escaped", pid: 4242 }],
        },
      },
      context,
    ),
  ).toThrow("residue_evidence_invalid");
});
