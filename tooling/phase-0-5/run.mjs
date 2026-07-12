import { assertDecision } from "./shared.mjs";
import { runCapacityLedgerGate } from "./capacity-ledger/gate.mjs";
import { runHyperQueueBoundaryGate } from "./hyperqueue-boundary/gate.mjs";
import { runNamespaceAnchorGate } from "./namespace-anchor/gate.mjs";
import { runPostgresBoundaryGate } from "./postgres-boundaries/gate.mjs";
import { runPressureAdmissionGate } from "./pressure-admission/gate.mjs";
import { runRuntimeOwnershipGate } from "./runtime-ownership/gate.mjs";
import { runSystemdLifecycleGate } from "./systemd-lifecycle/gate.mjs";

const runners = new Map([
  ["systemd_nested_lifecycle", runSystemdLifecycleGate],
  ["namespace_anchor_fd_pin", runNamespaceAnchorGate],
  ["postgres_atomic_acceptance", runPostgresBoundaryGate],
  ["bounded_capacity_ledger_cas", runCapacityLedgerGate],
  ["pinned_hyperqueue_cli_boundary", runHyperQueueBoundaryGate],
  ["pressure_admission_fail_closed", runPressureAdmissionGate],
]);

async function run() {
  const selected = process.argv[2];
  const decisions = [];
  let systemdDecision;
  for (const [gateId, runner] of runners) {
    if (selected !== undefined && selected !== gateId) continue;
    const decision = assertDecision(await runner());
    decisions.push(decision);
    if (gateId === "systemd_nested_lifecycle") systemdDecision = decision;
  }
  if (selected === undefined || selected === "foreground_runtime_ownership") {
    decisions.splice(
      Math.min(2, decisions.length),
      0,
      assertDecision(
        await runRuntimeOwnershipGate({
          systemdPassed: systemdDecision?.status === "pass",
        }),
      ),
    );
  }
  if (selected !== undefined && decisions.length === 0) {
    throw new Error(`Unknown Phase 0.5 gate: ${selected}`);
  }
  process.stdout.write(
    `${JSON.stringify({ decisions, schemaVersion: 1 }, null, 2)}\n`,
  );
}

await run();
