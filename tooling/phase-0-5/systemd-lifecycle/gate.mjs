import { evidence, readText, runCommand, unsupported } from "../shared.mjs";

const requiredHostEvidence = [
  "Run on a disposable Linux host booted with systemd as PID 1 and unified cgroup v2.",
  "Start a deterministic wf-feasibility-* transient unit with KillMode=control-group, MemoryMax and TasksMax.",
  "Capture unit name, InvocationID, MainPID, ControlGroup and node WAL before killing the harness at each durable boundary.",
  "Prove every descendant is absent after stop and classify separate bounded memory and PID limit fixtures from systemd/cgroup observations.",
];

export function classifyUnitObservation(observation) {
  if (observation.present !== true) return { status: "unknown" };
  if (observation.oomKilled === true) return { status: "memory_limit" };
  if (observation.tasksMaxReached === true) return { status: "pid_limit" };
  if (observation.active === false && observation.descendantCount === 0) {
    return { status: "canceled" };
  }
  return { status: "running" };
}

export function recoverUnitFromWal(wal, observation) {
  if (
    wal.unitName === undefined ||
    wal.invocationId === undefined ||
    wal.controlGroup === undefined ||
    wal.unitName !== observation.unitName ||
    wal.invocationId !== observation.invocationId ||
    wal.controlGroup !== observation.controlGroup
  ) {
    return { status: "unknown" };
  }
  return classifyUnitObservation(observation);
}

export function decideSystemdLifecycle(facts) {
  const observations = [
    evidence("systemd.platform", facts.platform === "linux", facts.platform),
    evidence("systemd.pid1", facts.pid1 === "systemd", facts.pid1),
    evidence("systemd.cgroup-v2", facts.cgroupV2, String(facts.cgroupV2)),
    evidence(
      "systemd.commands",
      facts.systemctl && facts.systemdRun,
      `systemctl=${facts.systemctl};systemd-run=${facts.systemdRun}`,
    ),
  ];

  if (
    facts.platform !== "linux" ||
    facts.pid1 !== "systemd" ||
    !facts.cgroupV2 ||
    !facts.systemctl ||
    !facts.systemdRun
  ) {
    return unsupported({
      capability: "deterministic_systemd_process_ownership",
      evidence: observations,
      gateId: "systemd_nested_lifecycle",
      invariantIds: ["WF-INV-003", "WF-INV-004", "WF-INV-015", "WF-INV-017"],
      reasonCode: "systemd_host_capability_unavailable",
      requiredHostEvidence,
    });
  }

  return unsupported({
    capability: "deterministic_systemd_process_ownership",
    evidence: [
      ...observations,
      evidence(
        "systemd.disposable-host-attestation",
        facts.disposableHost,
        String(facts.disposableHost),
      ),
    ],
    gateId: "systemd_nested_lifecycle",
    invariantIds: ["WF-INV-003", "WF-INV-004", "WF-INV-015", "WF-INV-017"],
    reasonCode: facts.disposableHost
      ? "destructive_host_scenario_requires_manual_evidence"
      : "disposable_host_attestation_missing",
    requiredHostEvidence,
  });
}

export async function runSystemdLifecycleGate() {
  const pid1 = (await readText("/proc/1/comm"))?.trim() ?? "unreadable";
  const systemctl = await runCommand("systemctl", ["--version"]);
  const systemdRun = await runCommand("systemd-run", ["--version"]);
  return decideSystemdLifecycle({
    cgroupV2:
      (await readText("/sys/fs/cgroup/cgroup.controllers")) !== undefined,
    disposableHost: process.env.WF_FEASIBILITY_DISPOSABLE_HOST === "1",
    pid1,
    platform: process.platform,
    systemctl: systemctl.code === 0,
    systemdRun: systemdRun.code === 0,
  });
}
