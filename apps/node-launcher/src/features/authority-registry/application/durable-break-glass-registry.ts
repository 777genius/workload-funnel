import type { MutationFence } from "@workload-funnel/kernel";

import {
  isExactOwnedExecution,
  sameBreakGlassIntent,
} from "./execution-tuple-binding.js";
import { type LauncherWal, LauncherWalError } from "./launcher-wal.js";
import {
  AuthorityRegistryError,
  type LauncherAuthoritySnapshot,
} from "../domain/authority-snapshot.js";
import type {
  BreakGlassWalRecord,
  StartWalRecord,
} from "../domain/launcher-wal-record.js";

export interface BreakGlassStopInput {
  readonly attemptId: string;
  readonly executionGeneration: string;
  readonly operationId: string;
  readonly mutationFence: MutationFence;
  readonly mutationFenceFingerprint: string;
  readonly nodeBootEpoch: number;
  readonly nodeBootId: string;
  readonly nodeId: string;
  readonly reason: string;
  readonly unitName: string;
}

export class DurableBreakGlassRegistry {
  readonly #outcomes = new Map<string, BreakGlassWalRecord>();

  public constructor(
    private readonly wal: LauncherWal,
    private readonly starts: () => Iterable<StartWalRecord>,
    private readonly snapshots: () => ReadonlyMap<
      string,
      LauncherAuthoritySnapshot
    >,
  ) {}

  public recover(record: BreakGlassWalRecord): void {
    if (
      !isExactOwnedExecution(record, this.starts(), this.snapshots(), this.wal)
    ) {
      throw new Error("break-glass WAL target tuple is not owned");
    }
    const prior = this.#outcomes.get(record.operationId);
    if (
      (prior === undefined && record.result !== "issued") ||
      (prior !== undefined &&
        (!sameBreakGlassIntent(prior, record) ||
          prior.result !== "issued" ||
          record.result !== "stopped_or_unknown"))
    ) {
      throw new Error("break-glass WAL transition changed its exact intent");
    }
    this.#outcomes.set(record.operationId, record);
  }

  public run(
    input: BreakGlassStopInput,
    mutation: () => void,
  ): "stopped" | "unknown" {
    if (
      !isExactOwnedExecution(input, this.starts(), this.snapshots(), this.wal)
    ) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "break-glass target is not an exact owned execution generation",
      );
    }
    const prior = this.#outcomes.get(input.operationId);
    if (prior !== undefined) {
      if (!sameBreakGlassIntent(prior, input)) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "break-glass operation replay changed its exact target tuple",
        );
      }
      return prior.result === "stopped_or_unknown" ? "stopped" : "unknown";
    }
    try {
      this.wal.reserve(2);
      const issued: BreakGlassWalRecord = {
        ...input,
        kind: "break_glass_stop",
        result: "issued",
      };
      this.wal.append(issued);
      this.#outcomes.set(input.operationId, issued);
      mutation();
      const completed: BreakGlassWalRecord = {
        ...input,
        kind: "break_glass_stop",
        result: "stopped_or_unknown",
      };
      this.wal.append(completed);
      this.#outcomes.set(input.operationId, completed);
      return "stopped";
    } catch (error) {
      if (error instanceof LauncherWalError) {
        throw new AuthorityRegistryError(
          "launcher_cordoned",
          "break-glass intervention could not be recorded",
        );
      }
      throw error;
    }
  }
}
