import { describe, expect, it } from "vitest";

import {
  decideNamespaceAnchor,
  planNamespaceCleanup,
  validateNamespaceIdentity,
} from "./gate.mjs";

describe("Phase 0.5 namespace anchor and FD pin gate", () => {
  it.each([
    ["private-only mount", { nsfs: false }],
    ["unverified helper", { verifiedHelper: false }],
    ["non-disposable host", { disposableHost: false }],
  ])("rejects %s without a downgrade", (_name, override) => {
    const decision = decideNamespaceAnchor({
      disposableHost: true,
      nsenter: true,
      nsfs: true,
      pid1: "systemd",
      platform: "linux",
      unshare: true,
      verifiedHelper: true,
      ...override,
    });

    expect(decision).toMatchObject({
      capability: "pinned_execution_paths",
      productionGate: "closed",
      reasonCode: "verified_namespace_probe_unavailable",
      status: "unsupported",
    });
  });

  it("requires the complete crash and anti-reuse matrix after prerequisites", () => {
    const decision = decideNamespaceAnchor({
      disposableHost: true,
      nsenter: true,
      nsfs: true,
      pid1: "systemd",
      platform: "linux",
      unshare: true,
      verifiedHelper: true,
    });

    expect(decision.reasonCode).toBe(
      "namespace_crash_matrix_requires_manual_evidence",
    );
    expect(decision.requiredHostEvidence.join(" ")).toContain("child-first");
  });

  it.each([
    "bootId",
    "invocationId",
    "mainPid",
    "namespaceInode",
    "pidStartTime",
  ])("rejects substituted %s before namespace join", (field) => {
    const expected = {
      bootId: "boot-1",
      invocationId: "invocation-1",
      mainPid: 42,
      namespaceInode: 91,
      pidStartTime: 7,
    };

    expect(
      validateNamespaceIdentity(expected, {
        ...expected,
        [field]: "substituted",
      }),
    ).toEqual({ mismatch: field, status: "rejected" });
  });

  it("requires child-first cleanup", () => {
    expect(planNamespaceCleanup({ workloadStopped: false })).toMatchObject({
      status: "blocked",
    });
    expect(planNamespaceCleanup({ workloadStopped: true })).toEqual({
      order: ["workload_service", "pinned_mounts", "anchor_service"],
      status: "ready",
    });
  });

  it("rejects an incomplete identity tuple", () => {
    expect(validateNamespaceIdentity({}, {})).toEqual({
      mismatch: "bootId",
      status: "rejected",
    });
  });
});
