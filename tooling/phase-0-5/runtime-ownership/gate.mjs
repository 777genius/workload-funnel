import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import { evidence, pass, runCommand, unsupported } from "../shared.mjs";

export class SyntheticRuntimeJournal {
  #path;

  constructor(path) {
    this.#path = path;
  }

  async dispatch(operationId, effect, crashAt = "none") {
    const previous = await this.lookup(operationId);
    if (previous?.status === "pending") {
      return {
        duplicate: true,
        operationId,
        status: "reconciliation_required",
      };
    }
    if (previous?.status === "confirmed") {
      return {
        duplicate: true,
        operationId,
        result: previous.result,
        status: "confirmed",
      };
    }
    if (crashAt === "before_effect") throw new Error("synthetic crash");

    await this.#appendDurable({ operationId, status: "pending" });
    const result = await effect();
    if (crashAt === "after_effect_before_receipt") {
      throw new Error("ambiguous synthetic crash");
    }

    const receipt = { operationId, result, status: "confirmed" };
    await this.#appendDurable(receipt);
    if (crashAt === "after_receipt") throw new Error("synthetic crash");
    return { duplicate: false, ...receipt };
  }

  async lookup(operationId) {
    const contents = await readFile(this.#path, "utf8").catch(() => "");
    let matched;
    for (const line of contents.trim().split("\n").filter(Boolean)) {
      const receipt = JSON.parse(line);
      if (receipt.operationId === operationId) matched = receipt;
    }
    return matched;
  }

  async #appendDurable(record) {
    const handle = await open(this.#path, "a");
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function decideRuntimeOwnership(facts) {
  const observations = [
    evidence(
      "runtime.foreground-child",
      facts.foregroundChild,
      String(facts.foregroundChild),
    ),
    evidence(
      "runtime.no-daemon-escape",
      facts.noDaemonEscape,
      String(facts.noDaemonEscape),
    ),
    evidence(
      "runtime.duplicate-receipt",
      facts.duplicateReceipt,
      String(facts.duplicateReceipt),
    ),
    evidence(
      "runtime.outer-systemd-boundary",
      facts.outerBoundaryVerified,
      String(facts.outerBoundaryVerified),
    ),
  ];
  const complete = Object.values(facts).every(Boolean);
  if (complete) {
    return pass({
      capability: "foreground_runtime_ownership",
      evidence: observations,
      gateId: "foreground_runtime_ownership",
      invariantIds: ["WF-INV-003", "WF-INV-005", "WF-INV-016", "WF-INV-027"],
    });
  }
  return unsupported({
    capability: "foreground_runtime_ownership",
    evidence: observations,
    gateId: "foreground_runtime_ownership",
    invariantIds: ["WF-INV-003", "WF-INV-005", "WF-INV-016", "WF-INV-027"],
    reasonCode: "foreground_runtime_outer_boundary_unverified",
    requiredHostEvidence: [
      "Run the synthetic runtime as the foreground ExecStart process of the passed deterministic transient unit.",
      "Capture MainPID/cgroup membership and prove no tmux, daemon, double-fork, or host-level child escapes.",
      "Crash before effect, after effect/before receipt, and after durable receipt; show duplicate operation IDs never repeat a known effect.",
    ],
  });
}

export async function runRuntimeOwnershipGate(context = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "wf-feasibility-runtime-run-"),
  );
  try {
    let effects = 0;
    const journal = new SyntheticRuntimeJournal(
      join(directory, "receipts.jsonl"),
    );
    const effect = () => {
      effects += 1;
      return Promise.resolve("synthetic-result");
    };
    const first = await journal.dispatch("synthetic-operation", effect);
    const duplicate = await journal.dispatch("synthetic-operation", effect);
    const reportPath = join(directory, "child-report.json");
    const child = await runCommand(
      process.execPath,
      [
        new URL("./synthetic-runtime.mjs", import.meta.url).pathname,
        reportPath,
      ],
      {
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== "TMUX"),
        ),
      },
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    return decideRuntimeOwnership({
      duplicateReceipt:
        first.duplicate === false &&
        duplicate.duplicate === true &&
        effects === 1,
      foregroundChild: child.code === 0 && report.ppid === process.pid,
      noDaemonEscape: report.daemonized === false && report.tmux === false,
      outerBoundaryVerified: context.systemdPassed === true,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
