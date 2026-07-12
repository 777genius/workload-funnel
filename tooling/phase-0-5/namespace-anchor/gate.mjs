import { evidence, readText, runCommand, unsupported } from "../shared.mjs";

const requiredHostEvidence = [
  "Build and run a peer-reviewed SCM_RIGHTS/setns probe on a disposable root-capable systemd host.",
  "Record boot ID, anchor InvocationID/MainPID/PID-start/nsfs inode before and after launcher pinning.",
  "Prove the launcher-created root-owned nsfs bind in launcher and fresh host mountinfo, and prove private mounts appear only after setns.",
  "Kill after every WAL boundary; restart launcher and anchor, reject all substituted identities and PID reuse, then reboot and reject the old WAL/path.",
  "Prove fixed workload join, privilege drop/exec, and child-first cleanup without pathname, JoinsNamespaceOf, or unpinned-PID fallback.",
];

const identityFields = [
  "bootId",
  "invocationId",
  "mainPid",
  "namespaceInode",
  "pidStartTime",
];

export function validateNamespaceIdentity(expected, observed) {
  const mismatch = identityFields.find(
    (field) =>
      expected[field] === undefined ||
      observed[field] === undefined ||
      expected[field] !== observed[field],
  );
  return mismatch === undefined
    ? { status: "matched" }
    : { mismatch, status: "rejected" };
}

export function planNamespaceCleanup({ workloadStopped }) {
  if (!workloadStopped)
    return { reason: "workload_may_still_join", status: "blocked" };
  return {
    order: ["workload_service", "pinned_mounts", "anchor_service"],
    status: "ready",
  };
}

export function decideNamespaceAnchor(facts) {
  const observations = [
    evidence("namespace.platform", facts.platform === "linux", facts.platform),
    evidence("namespace.systemd-pid1", facts.pid1 === "systemd", facts.pid1),
    evidence("namespace.nsfs", facts.nsfs, String(facts.nsfs)),
    evidence(
      "namespace.tools",
      facts.unshare && facts.nsenter,
      `unshare=${facts.unshare};nsenter=${facts.nsenter}`,
    ),
    evidence(
      "namespace.scm-rights-helper",
      facts.verifiedHelper,
      String(facts.verifiedHelper),
    ),
  ];
  const prerequisites =
    facts.platform === "linux" &&
    facts.pid1 === "systemd" &&
    facts.nsfs &&
    facts.unshare &&
    facts.nsenter &&
    facts.verifiedHelper &&
    facts.disposableHost;

  return unsupported({
    capability: "pinned_execution_paths",
    evidence: observations,
    gateId: "namespace_anchor_fd_pin",
    invariantIds: ["WF-INV-003", "WF-INV-043", "WF-INV-049", "WF-INV-053"],
    reasonCode: prerequisites
      ? "namespace_crash_matrix_requires_manual_evidence"
      : "verified_namespace_probe_unavailable",
    requiredHostEvidence,
  });
}

export async function runNamespaceAnchorGate() {
  const pid1 = (await readText("/proc/1/comm"))?.trim() ?? "unreadable";
  const unshare = await runCommand("unshare", ["--version"]);
  const nsenter = await runCommand("nsenter", ["--version"]);
  const filesystems = (await readText("/proc/filesystems")) ?? "";
  return decideNamespaceAnchor({
    disposableHost: process.env.WF_FEASIBILITY_DISPOSABLE_HOST === "1",
    nsenter: nsenter.code === 0,
    nsfs: filesystems.includes("nsfs"),
    pid1,
    platform: process.platform,
    unshare: unshare.code === 0,
    verifiedHelper: process.env.WF_NAMESPACE_PROBE_HELPER_VERIFIED === "1",
  });
}
