import { evidence, unsupported } from "../shared.mjs";

export class CapacityLedger {
  #capacity;
  #reserved = { cpu: 0, memory: 0 };
  #revision = 0;

  constructor(capacity) {
    this.#capacity = Object.freeze({ ...capacity });
  }

  snapshot() {
    return Object.freeze({
      reserved: Object.freeze({ ...this.#reserved }),
      revision: this.#revision,
    });
  }

  tryReserve(expectedRevision, request) {
    if (
      !Number.isFinite(request.cpu) ||
      !Number.isFinite(request.memory) ||
      request.cpu <= 0 ||
      request.memory <= 0
    ) {
      return { status: "invalid_request" };
    }
    if (expectedRevision !== this.#revision) return { status: "cas_conflict" };
    if (
      this.#reserved.cpu + request.cpu > this.#capacity.cpu ||
      this.#reserved.memory + request.memory > this.#capacity.memory
    ) {
      return { status: "insufficient_capacity" };
    }
    this.#reserved = {
      cpu: this.#reserved.cpu + request.cpu,
      memory: this.#reserved.memory + request.memory,
    };
    this.#revision += 1;
    return { revision: this.#revision, status: "reserved" };
  }
}

export function runContentionScenario({ attempts = 128, retryBound = 4 } = {}) {
  const ledger = new CapacityLedger({ cpu: 8, memory: 16 });
  let conflicts = 0;
  let rejected = 0;
  let reserved = 0;
  for (let index = 0; index < attempts; index += 2) {
    const shared = ledger.snapshot();
    for (const request of [
      { cpu: 1, memory: 2 },
      { cpu: 2, memory: 1 },
    ]) {
      let snapshot = shared;
      let result = ledger.tryReserve(snapshot.revision, request);
      for (
        let retry = 0;
        result.status === "cas_conflict" && retry < retryBound;
        retry += 1
      ) {
        conflicts += 1;
        snapshot = ledger.snapshot();
        result = ledger.tryReserve(snapshot.revision, request);
      }
      if (result.status === "reserved") reserved += 1;
      else rejected += 1;
    }
  }
  return {
    conflicts,
    final: ledger.snapshot(),
    rejected,
    reserved,
    retryBound,
  };
}

export async function runCapacityLedgerGate() {
  const result = runContentionScenario();
  const bounded = result.conflicts <= result.retryBound * 128;
  const noOvercommit =
    result.final.reserved.cpu <= 8 && result.final.reserved.memory <= 16;
  return unsupported({
    capability: "bounded_capacity_reservation",
    evidence: [
      evidence(
        "capacity.no-overcommit",
        noOvercommit,
        JSON.stringify(result.final),
      ),
      evidence(
        "capacity.bounded-cas",
        bounded,
        `conflicts=${result.conflicts};bound=${result.retryBound}`,
      ),
      evidence(
        "capacity.contention",
        result.conflicts > 0,
        `conflicts=${result.conflicts}`,
      ),
    ],
    gateId: "bounded_capacity_ledger_cas",
    invariantIds: ["WF-INV-007", "WF-INV-042", "WF-INV-046"],
    reasonCode: "transactional_capacity_contention_unverified",
    requiredHostEvidence: [
      "Run concurrent reservations against the disposable canonical database using the planned compare-and-swap transaction and hard-resource dimensions.",
      "Capture bounded retry counts, committed revisions, rejected reservations, and final totals under contention.",
      "Prove no hard-resource overcommit across process crashes and transaction retries before enabling this capability.",
    ],
  });
}
