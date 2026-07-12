import { evidence, pass, runCommand, unsupported } from "../shared.mjs";

export class SyntheticAcceptanceTransaction {
  #state = { idempotency: new Map(), outbox: [], workloads: new Map() };

  accept({ idempotencyKey, operationId, workloadId }, crashAt = "none") {
    const existing = this.#state.idempotency.get(idempotencyKey);
    if (existing !== undefined)
      return { duplicate: true, workloadId: existing };

    const next = {
      idempotency: new Map(this.#state.idempotency),
      outbox: [...this.#state.outbox],
      workloads: new Map(this.#state.workloads),
    };
    next.workloads.set(workloadId, { workloadId });
    next.idempotency.set(idempotencyKey, workloadId);
    next.outbox.push({ operationId, type: "WorkloadAccepted", workloadId });
    if (crashAt === "before_commit") throw new Error("synthetic crash");
    this.#state = next;
    if (crashAt === "after_commit_before_ack")
      throw new Error("synthetic crash");
    return { duplicate: false, workloadId };
  }

  snapshot() {
    return {
      idempotency: Object.fromEntries(this.#state.idempotency),
      outbox: this.#state.outbox.map((item) => ({ ...item })),
      workloads: [...this.#state.workloads.keys()],
    };
  }
}

export function decidePostgresBoundaries(facts) {
  const observations = [
    evidence("postgres.psql", facts.psql, String(facts.psql)),
    evidence(
      "postgres.disposable-database",
      facts.disposableDatabase,
      String(facts.disposableDatabase),
    ),
    evidence(
      "postgres.crash-matrix",
      facts.crashMatrixPassed,
      String(facts.crashMatrixPassed),
    ),
  ];
  if (Object.values(facts).every(Boolean)) {
    return pass({
      capability: "postgres_atomic_acceptance",
      evidence: observations,
      gateId: "postgres_atomic_acceptance",
      invariantIds: ["WF-INV-001", "WF-INV-005", "WF-INV-008", "WF-INV-025"],
    });
  }
  return unsupported({
    capability: "postgres_atomic_acceptance",
    evidence: observations,
    gateId: "postgres_atomic_acceptance",
    invariantIds: ["WF-INV-001", "WF-INV-005", "WF-INV-008", "WF-INV-025"],
    reasonCode: "disposable_postgres_probe_unavailable",
    requiredHostEvidence: [
      "Provide WF_FEASIBILITY_POSTGRES_URL for a dedicated database whose name starts wf_feasibility_.",
      "Apply the probe schema and capture one transaction containing idempotency receipt, canonical workload mutation, and outbox insert.",
      "SIGKILL before/after BEGIN, each statement, COMMIT request/result, and response ack; recover to zero state or one stable workload/outbox receipt.",
      "Run concurrent duplicate requests and prove stable identity with one canonical mutation and one outbox operation.",
    ],
  });
}

export async function runPostgresBoundaryGate() {
  const psql = await runCommand("psql", ["--version"]);
  const url = process.env.WF_FEASIBILITY_POSTGRES_URL ?? "";
  const databaseName = url.split("/").at(-1)?.split("?")[0] ?? "";
  return decidePostgresBoundaries({
    crashMatrixPassed: false,
    disposableDatabase: databaseName.startsWith("wf_feasibility_"),
    psql: psql.code === 0,
  });
}
