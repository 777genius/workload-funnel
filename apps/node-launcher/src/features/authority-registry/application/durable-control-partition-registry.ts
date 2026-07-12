import type { ExecutionTicketClaims } from "@workload-funnel/node-execution/execution-ticket-validation";

import {
  exactStartForClaims,
  recoveredStartForPartition,
} from "./execution-tuple-binding.js";
import { type LauncherWal, LauncherWalError } from "./launcher-wal.js";
import { AuthorityRegistryError } from "../domain/authority-snapshot.js";
import type {
  ControlPartitionWalRecord,
  StartWalRecord,
} from "../domain/launcher-wal-record.js";

export interface ControlPartitionInput {
  readonly claims: ExecutionTicketClaims;
  readonly disconnectedAtMs: number;
  readonly nowMs: number;
  readonly stopAtMs: number;
  readonly unitName: string;
}

export interface ControlPartitionResult {
  readonly state: "scheduled" | "stopped" | "unknown";
  readonly stopAtMs: number;
}

function sameIntent(
  record: ControlPartitionWalRecord,
  intent: Omit<ControlPartitionWalRecord, "kind" | "state">,
): boolean {
  return (
    record.attemptId === intent.attemptId &&
    record.disconnectedAtMs === intent.disconnectedAtMs &&
    record.executionGeneration === intent.executionGeneration &&
    record.mutationFenceFingerprint === intent.mutationFenceFingerprint &&
    record.nodeBootEpoch === intent.nodeBootEpoch &&
    record.nodeBootId === intent.nodeBootId &&
    record.nodeId === intent.nodeId &&
    record.partitionPolicy === intent.partitionPolicy &&
    record.stopAtMs === intent.stopAtMs &&
    record.unitName === intent.unitName
  );
}

export class DurableControlPartitionRegistry {
  readonly #records = new Map<string, ControlPartitionWalRecord>();

  public constructor(
    private readonly wal: LauncherWal,
    private readonly starts: () => Iterable<StartWalRecord>,
  ) {}

  public get active(): boolean {
    return this.#records.size > 0;
  }

  public recover(record: ControlPartitionWalRecord): void {
    if (recoveredStartForPartition(this.starts(), record) === undefined) {
      throw new Error("control-partition WAL is not bound to a durable start");
    }
    const prior = this.#records.get(record.unitName);
    const validTransition =
      (prior === undefined && record.state === "scheduled") ||
      (prior?.state === "scheduled" && record.state === "stop_issued") ||
      (prior?.state === "stop_issued" && record.state === "stopped_or_unknown");
    if (
      !validTransition ||
      (prior !== undefined && !sameIntent(prior, record))
    ) {
      throw new Error("control-partition WAL intent changed");
    }
    this.#records.set(record.unitName, record);
  }

  public run(
    input: ControlPartitionInput,
    mutation: () => void,
  ): ControlPartitionResult {
    this.validateDeadline(input);
    const start = exactStartForClaims(
      this.starts(),
      input.claims,
      input.unitName,
    );
    if (start === undefined) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "control-partition target does not equal its durable start tuple",
      );
    }
    const intent = {
      attemptId: start.attemptId,
      disconnectedAtMs: input.disconnectedAtMs,
      executionGeneration: start.executionGeneration,
      mutationFenceFingerprint: start.mutationFenceFingerprint,
      nodeBootEpoch: start.nodeBootEpoch,
      nodeBootId: start.nodeBootId,
      nodeId: start.nodeId,
      partitionPolicy: start.partitionPolicy,
      stopAtMs: input.stopAtMs,
      unitName: start.unitName,
    } as const;
    const existing = this.#records.get(input.unitName);
    if (existing !== undefined && !sameIntent(existing, intent)) {
      throw new AuthorityRegistryError(
        "authority_mismatch",
        "control-partition replay changed its generation-bound deadline",
      );
    }
    try {
      if (existing === undefined) {
        this.append({
          ...intent,
          kind: "control_partition",
          state: "scheduled",
        });
        if (input.nowMs < input.stopAtMs) {
          return { state: "scheduled", stopAtMs: input.stopAtMs };
        }
      } else if (existing.state === "stopped_or_unknown") {
        return { state: "stopped", stopAtMs: existing.stopAtMs };
      } else if (input.nowMs < existing.stopAtMs) {
        return { state: "scheduled", stopAtMs: existing.stopAtMs };
      }
      this.wal.reserve(2);
      this.append({
        ...intent,
        kind: "control_partition",
        state: "stop_issued",
      });
      mutation();
      this.append({
        ...intent,
        kind: "control_partition",
        state: "stopped_or_unknown",
      });
      return { state: "stopped", stopAtMs: input.stopAtMs };
    } catch (error) {
      this.translateWalError(error);
    }
  }

  public reconcile(
    nowMs: number,
    mutation: (start: StartWalRecord) => void,
  ): number {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "control-partition reconciliation time is invalid",
      );
    }
    let stopped = 0;
    for (const partition of this.#records.values()) {
      if (
        partition.state === "stopped_or_unknown" ||
        nowMs < partition.stopAtMs
      ) {
        continue;
      }
      const start = recoveredStartForPartition(this.starts(), partition);
      if (start === undefined) {
        throw new AuthorityRegistryError(
          "authority_mismatch",
          "partition deadline lost its durable start tuple",
        );
      }
      try {
        this.wal.reserve(partition.state === "scheduled" ? 2 : 1);
        if (partition.state === "scheduled") {
          this.append({ ...partition, state: "stop_issued" });
        }
        mutation(start);
        this.append({ ...partition, state: "stopped_or_unknown" });
        stopped += 1;
      } catch (error) {
        this.translateWalError(error);
      }
    }
    return stopped;
  }

  private append(record: ControlPartitionWalRecord): void {
    this.wal.append(record);
    this.#records.set(record.unitName, record);
  }

  private translateWalError(error: unknown): never {
    if (error instanceof LauncherWalError) {
      throw new AuthorityRegistryError(
        "launcher_cordoned",
        "control-partition stop could not be durably reconciled",
      );
    }
    throw error;
  }

  private validateDeadline(input: ControlPartitionInput): void {
    if (
      !Number.isSafeInteger(input.disconnectedAtMs) ||
      input.disconnectedAtMs < 0 ||
      !Number.isSafeInteger(input.nowMs) ||
      input.nowMs < input.disconnectedAtMs ||
      !Number.isSafeInteger(input.stopAtMs) ||
      input.stopAtMs < input.disconnectedAtMs
    ) {
      throw new AuthorityRegistryError(
        "invalid_authority",
        "control-partition deadline is invalid",
      );
    }
  }
}
